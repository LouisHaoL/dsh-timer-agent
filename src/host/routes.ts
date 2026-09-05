/**
 * The /api/dsh-timer-agent route family: the browser half's read/write
 * window onto the host-authoritative ledger. Every route carries the same
 * loopback-only trust fence dsh-ssh uses (these endpoints can fire real
 * agent sessions, so LAN-exposed dsh web deployments must not serve them).
 *
 * - GET    /api/dsh-timer-agent/jobs          → the full ledger
 * - POST   /api/dsh-timer-agent/jobs          → create a job (cron / interval /
 *                                              one-shot via runAt)
 * - PATCH  /api/dsh-timer-agent/jobs?id=…     → update fields / arm cron /
 *                                              pin nextRunAt (non-cron modes)
 * - DELETE /api/dsh-timer-agent/jobs?id=…     → remove
 * - POST   /api/dsh-timer-agent/jobs/run?id=… → fire now (background)
 * - GET    /api/dsh-timer-agent/workspaces    → host workspace registry {id,path}
 * - GET    /api/dsh-timer-agent/model-options → default model + provider/model catalog
 * - GET    /api/dsh-timer-agent/preset-options→ default preset id + preset roster
 *
 * @module dsh-timer-agent/routes
 */
import { randomUUID } from 'node:crypto'
import type {
  HostPluginContext, HostRoute, NodeIncomingMessage, NodeServerResponse,
} from './contracts.ts'
import {
  intervalNextMs, isIntervalRule, isOneShotRule, isSchedulable, isValidCron,
  nextRunAtMs, resumeNextMs, scheduleNextMs,
} from '../core/schedule.ts'
import { createJob, normalizeTimeoutMs, withSchedule, withStatus, type JobModelSelection, type JobRecord } from '../core/jobs.ts'
import type { HostJobStore } from './store.ts'
import type { TimerRunner } from './runner.ts'

/** Cap on JSON bodies (job rows are small). */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** Loopback literal check plus browser same-origin markers (dsh-ssh fence). */
function isLoopbackRequest(request: NodeIncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const originHeader = request.headers.origin
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: NodeServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: NodeIncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** First query param value from the request url. */
function queryParam(req: NodeIncomingMessage, key: string): string | undefined {
  const raw = req.url ?? '/'
  const index = raw.indexOf('?')
  if (index === -1) return undefined
  for (const pair of raw.slice(index + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (decodeURIComponent(pair.slice(0, eq)) === key) {
      return decodeURIComponent(pair.slice(eq + 1))
    }
  }
  return undefined
}

/** Validate an unknown body value as a model selection; undefined = follow default. */
function readModelSelection(value: unknown): JobModelSelection | 'invalid' | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return 'invalid'
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (provider === '' || model === '') return 'invalid'
  return { provider, model }
}

/** Re-anchor a schedule at `now`: an interval grid continues from the last
 *  trigger (stacking whole intervals past the gap); cron follows its grid. */
function reanchorMs(schedule: NonNullable<JobRecord['schedule']>, now: number): number | undefined {
  return isIntervalRule(schedule)
    ? intervalNextMs(schedule.lastTriggeredAt, schedule.intervalMinutes!, now)
    : scheduleNextMs(schedule, now)
}

/**
 * The REAL last-execution instant a resume/restart re-anchors on: the latest
 * execution's startedAt (a manual run counts — it re-anchored the grid too),
 * falling back to the schedule's lastTriggeredAt for rows that never ran.
 */
function lastExecutionMs(job: JobRecord): number | undefined {
  return job.executions.length > 0
    ? job.executions[job.executions.length - 1].startedAt
    : job.schedule?.lastTriggeredAt ?? undefined
}

/**
 * Parse a body instant (ms epoch number, or ISO datetime string) into a
 * finite positive ms epoch; undefined when absent or unparseable.
 */
function readInstantMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

/** Dependencies the routes close over. */
export interface RouteDeps {
  store: HostJobStore
  runner: TimerRunner
  ctx: HostPluginContext
  now(): number
}

/**
 * Build the route family.
 * @param deps - store/runner/context/clock faces.
 * @returns the routes to register on the webserver.
 */
export function makeRoutes(deps: RouteDeps): HostRoute[] {
  const jobsRoute: HostRoute = {
    kind: 'exact',
    path: '/api/dsh-timer-agent/jobs',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      const method = req.method ?? 'GET'
      if (method === 'GET') {
        writeJson(res, 200, { jobs: await deps.store.load() })
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') {
          writeJson(res, 400, { error: 'title is required' })
          return
        }
        const cron = typeof body.cron === 'string' ? body.cron.trim() : ''
        const armCron = cron !== ''
        if (armCron && !isValidCron(cron)) {
          writeJson(res, 400, { error: `invalid cron expression: ${cron}` })
          return
        }
        // Fixed-interval alternative to cron (minutes from the last trigger).
        const intervalMinutes = typeof body.intervalMinutes === 'number' && body.intervalMinutes > 0
          ? Math.round(body.intervalMinutes)
          : undefined
        // One-shot alternative: a single runAt instant (ms epoch or ISO) when
        // neither cron nor interval is given. With cron/interval present it is
        // ignored (precedence interval > cron > runAt, no error).
        const runAt = intervalMinutes === undefined && !armCron ? readInstantMs(body.runAt) : undefined
        if (intervalMinutes === undefined && !armCron
          && body.runAt !== undefined && runAt === undefined) {
          writeJson(res, 400, { error: 'invalid runAt (expected a ms epoch number or ISO datetime string)' })
          return
        }
        const kind = body.kind === 'command' ? 'command' : 'agent'
        const command = typeof body.command === 'string' ? body.command.trim() : ''
        const args = typeof body.args === 'string' ? body.args : ''
        if (kind === 'command' && command === '') {
          writeJson(res, 400, { error: 'command is required for command jobs' })
          return
        }
        const target = (typeof body.target === 'object' && body.target !== null ? body.target : {}) as Record<string, unknown>
        const modelSelection = readModelSelection(body.modelSelection)
        if (modelSelection === 'invalid') {
          writeJson(res, 400, { error: 'modelSelection must be { provider, model }' })
          return
        }
        // Agent-preset id for new sessions (agent jobs; blank → default).
        const preset = kind === 'agent' && typeof body.preset === 'string' ? body.preset.trim() : ''
        let job = createJob({
          title,
          description: typeof body.description === 'string' ? body.description : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          ...(kind === 'command' ? { kind: 'command' as const, command, args } : {}),
          target: {
            workdir: typeof target.workdir === 'string' ? target.workdir.trim() : '',
            sessionId: typeof target.sessionId === 'string' ? target.sessionId.trim() : '',
          },
          ...(preset === '' ? {} : { preset }),
          ...modelSelection === undefined ? {} : { modelSelection },
        }, deps.now(), randomUUID())
        if (typeof body.timeoutMinutes === 'number') {
          const timeoutMs = normalizeTimeoutMs(body.timeoutMinutes * 60_000)
          if (timeoutMs === undefined) delete job.timeoutMs
          else job = { ...job, timeoutMs }
        }
        if (intervalMinutes !== undefined) {
          job = withSchedule(
            job,
            { enabled: true, intervalMinutes, nextRunAt: deps.now() + intervalMinutes * 60_000 },
            deps.now(),
          )
        } else if (armCron) {
          job = withSchedule(job, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, deps.now()) }, deps.now())
        } else if (runAt !== undefined) {
          // One-shot: no recurrence expression — the persisted instant is the
          // whole schedule, consumed by its single execution.
          job = withSchedule(job, { enabled: true, cron: '', nextRunAt: runAt }, deps.now())
        }
        await deps.store.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
        writeJson(res, 201, { job })
        return
      }
      if (method === 'PATCH') {
        const id = queryParam(req, 'id')
        if (id === undefined || id === '') {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const updated = await deps.store.mutate(jobs => {
          const job = jobs.find(candidate => candidate.id === id)
          if (job === undefined) return undefined
          let next: JobRecord = { ...job, updatedAt: deps.now() }
          if (typeof body.title === 'string' && body.title.trim() !== '') next = { ...next, title: body.title.trim() }
          if (typeof body.description === 'string') next = { ...next, description: body.description }
          if (typeof body.prompt === 'string') next = { ...next, prompt: body.prompt }
          // Kind switch (agent ↔ command) and/or command-line edits. A command
          // job must keep a non-empty command; switching to agent clears the
          // exec fields.
          if (body.kind === 'command') {
            const command = typeof body.command === 'string' ? body.command.trim() : (next.command ?? '')
            if (command === '') return undefined
            next = {
              ...next,
              kind: 'command',
              command,
              args: typeof body.args === 'string' ? body.args : (next.args ?? ''),
            }
          } else if (body.kind === 'agent') {
            next = { ...next }
            delete next.kind
            delete next.command
            delete next.args
          } else if (body.command !== undefined || body.args !== undefined) {
            if (next.kind !== 'command') return undefined
            const command = typeof body.command === 'string' ? body.command.trim() : (next.command ?? '')
            if (command === '') return undefined
            next = {
              ...next,
              kind: 'command',
              command,
              args: typeof body.args === 'string' ? body.args : (next.args ?? ''),
            }
          }
          if ('timeoutMinutes' in body && typeof body.timeoutMinutes === 'number') {
            const timeoutMs = normalizeTimeoutMs(body.timeoutMinutes * 60_000)
            if (timeoutMs === undefined) delete next.timeoutMs
            else next = { ...next, timeoutMs }
          }
          if ('modelSelection' in body) {
            const modelSelection = readModelSelection(body.modelSelection)
            if (modelSelection === 'invalid') return undefined
            if (modelSelection === undefined) next = { ...next }
            else next = { ...next, modelSelection }
            if (modelSelection === undefined) delete (next as { modelSelection?: JobModelSelection }).modelSelection
          }
          // Agent-preset id for new sessions: a non-empty string pins it, an
          // empty string clears it (back to the roster default); absent =
          // untouched. Command jobs never carry one.
          if (typeof body.preset === 'string') {
            const preset = body.preset.trim()
            next = { ...next }
            if (preset === '' || next.kind === 'command') delete next.preset
            else next.preset = preset
          }
          if (typeof body.target === 'object' && body.target !== null) {
            const target = body.target as Record<string, unknown>
            next = {
              ...next,
              target: {
                workdir: typeof target.workdir === 'string' ? target.workdir.trim() : next.target.workdir,
                sessionId: typeof target.sessionId === 'string' ? target.sessionId.trim() : next.target.sessionId,
              },
            }
          }
          if (typeof body.intervalMinutes === 'number') {
            // > 0 → fixed-interval mode (cron cleared); <= 0 → back to cron mode.
            next = withSchedule(next, { intervalMinutes: body.intervalMinutes > 0 ? Math.round(body.intervalMinutes) : undefined }, deps.now())
            if (next.schedule?.enabled === true &&
              (next.schedule.nextRunAt === undefined || next.schedule.nextRunAt <= deps.now())) {
              // Interval switch: keep a still-future nextRunAt (e.g. a hand-
              // pinned first-run time); otherwise re-anchor on the last trigger.
              const reanchored = reanchorMs(next.schedule, deps.now())
              if (reanchored === undefined) return undefined
              next = withSchedule(next, { nextRunAt: reanchored }, deps.now())
            }
          }
          if (typeof body.cron === 'string' && body.cron.trim() !== '') {
            const cron = body.cron.trim()
            if (!isValidCron(cron)) return undefined
            // An explicit cron clears interval mode.
            next = withSchedule(next, { cron, intervalMinutes: undefined }, deps.now())
            // An armed schedule must pick up the NEW cron immediately: roll
            // nextRunAt from now so the displayed/effective next run matches
            // the edited expression instead of the stale one.
            if (next.schedule?.enabled === true) {
              next = withSchedule(next, { enabled: true, nextRunAt: nextRunAtMs(cron, deps.now()) }, deps.now())
            }
          }
          // Hand-pinned next run (interval and one-shot modes — the persisted
          // instant IS their execution basis). A cron grid refuses: its instants
          // belong to the expression, edit that instead. A job without a
          // schedule refuses too (nothing for the instant to attach to).
          if (body.nextRunAt !== undefined) {
            const pinned = readInstantMs(body.nextRunAt)
            if (pinned === undefined || next.schedule === undefined
              || (next.schedule.cron ?? '') !== '') return undefined
            next = withSchedule(next, { nextRunAt: pinned }, deps.now())
          }
          if (body.scheduleEnabled === true) {
            const schedule = next.schedule
            if (schedule === undefined || !isSchedulable(schedule)) return undefined
            // Resume re-anchors on the REAL last execution, skipping missed
            // slots (no catch-up replay). A one-shot passes its persisted
            // instant through even when past — resuming deliberately fires
            // the pending shot on the next tick.
            const armed = resumeNextMs(schedule, lastExecutionMs(next), deps.now())
            if (armed === undefined) return undefined
            next = withSchedule(next, { enabled: true, nextRunAt: armed }, deps.now())
          }
          // Pause keeps the persisted nextRunAt: the pending instant (a
          // one-shot's whole schedule in particular) survives the pause and
          // re-arms unchanged on resume.
          if (body.scheduleEnabled === false) {
            next = withSchedule(next, { enabled: false }, deps.now())
          }
          if (body.resetStatus === true) next = withStatus(next, 'idle', deps.now())
          // Archive freezes the job (no schedule fires, no manual runs); a
          // running job refuses the archive until its execution settles.
          if (body.archived === true && next.status !== 'running') {
            next = withStatus(next, 'archived', deps.now())
          }
          // Restart un-archives: back to idle; a recurring schedule re-arms
          // from the real last execution (missed slots skipped). A one-shot
          // restart has nothing to re-arm — its instant was consumed by the
          // run that archived it — so the schedule stays exactly as it is.
          if (body.restart === true && next.status === 'archived') {
            next = withStatus(next, 'idle', deps.now())
            const schedule = next.schedule
            if (schedule?.enabled === true && isSchedulable(schedule) && !isOneShotRule(schedule)) {
              const armed = resumeNextMs(schedule, lastExecutionMs(next), deps.now())
              if (armed === undefined) return undefined
              next = withSchedule(next, { enabled: true, nextRunAt: armed }, deps.now())
            }
          }
          // Skip-once: roll nextRunAt forward ONE occurrence so the next fire
          // is dropped. Base = max(nextRunAt, now): a future nextRunAt skips
          // the displayed run; a stale (missed) nextRunAt skips the imminent
          // catch-up fire instead of landing on an already-past ghost.
          if (body.skipNext === true) {
            const schedule = next.schedule
            if (schedule?.enabled !== true || !isSchedulable(schedule)) return undefined
            // A one-shot has no "next occurrence" to skip — refusing (the UI
            // hides the action) beats silently spending the only shot.
            if (isOneShotRule(schedule)) return undefined
            const base = Math.max(schedule.nextRunAt ?? deps.now(), deps.now())
            const skipped = isIntervalRule(schedule)
              ? scheduleNextMs(schedule, base)
              : nextRunAtMs(schedule.cron, base)
            if (skipped === undefined) return undefined
            next = withSchedule(next, { enabled: true, nextRunAt: skipped }, deps.now())
          }
          return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
        })
        if (updated === undefined) {
          writeJson(res, 400, { error: 'job not found or invalid fields' })
          return
        }
        writeJson(res, 200, { job: updated })
        return
      }
      if (method === 'DELETE') {
        const id = queryParam(req, 'id')
        if (id === undefined || id === '') {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        const removed = await deps.store.mutate(jobs => {
          if (!jobs.some(job => job.id === id)) return undefined
          return { jobs: jobs.filter(job => job.id !== id), result: true }
        })
        if (removed === undefined) {
          writeJson(res, 404, { error: 'job not found' })
          return
        }
        writeJson(res, 200, { ok: true })
        return
      }
      writeJson(res, 405, { error: `method not allowed: ${method}` })
    },
  }

  const runRoute: HostRoute = {
    kind: 'exact',
    path: '/api/dsh-timer-agent/jobs/run',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        return
      }
      const id = queryParam(req, 'id')
      if (id === undefined || id === '') {
        writeJson(res, 400, { error: 'id query parameter is required' })
        return
      }
      const accepted = await deps.runner.requestRun(id)
      if (!accepted) {
        writeJson(res, 409, { error: 'job not found or already running' })
        return
      }
      writeJson(res, 202, { ok: true, note: 'fired in the background' })
    },
  }

  const workspacesRoute: HostRoute = {
    kind: 'exact',
    path: '/api/dsh-timer-agent/workspaces',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        return
      }
      const registry = deps.ctx.get('workspaceRegistry') as
        | { list?(): ReadonlyArray<{ id: string; path: string }> }
        | undefined
      const items = registry?.list?.() ?? []
      writeJson(res, 200, { workspaces: items.map(item => ({ id: item.id, path: item.path })) })
    },
  }

  const modelOptionsRoute: HostRoute = {
    kind: 'exact',
    path: '/api/dsh-timer-agent/model-options',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        return
      }
      // The deployment default (agentDefaultModel) plus the live provider/
      // model catalog over every registered route; per-provider failures ride
      // `failures` without failing the sound groups (api-proxy precedent).
      let fallback: { provider: string, model: string } | undefined
      try {
        fallback = deps.ctx.get('agentDefaultModel')?.currentSelection()
      } catch {
        fallback = undefined
      }
      const llm = deps.ctx.get('llm')
      const groups: Array<{ id: string, name: string, models: Array<{ id: string, name: string }> }> = []
      const failures: Array<{ id: string, name: string, message: string }> = []
      if (llm !== undefined) {
        await Promise.all(llm.listProviders().map(async provider => {
          try {
            const models = await llm.listModels(provider.id)
            const entries = models.map(model => ({ id: model.id, name: model.name }))
            if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries })
          } catch (error: unknown) {
            failures.push({
              id: provider.id,
              name: provider.name,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }))
      }
      writeJson(res, 200, { default: fallback, groups, failures })
    },
  }

  const presetOptionsRoute: HostRoute = {
    kind: 'exact',
    path: '/api/dsh-timer-agent/preset-options',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        return
      }
      // The roster default plus every discovered preset row (broken ones
      // included — the picker shows them as unusable rather than hiding the
      // id a job may already reference). Absent service → empty roster.
      const presets = deps.ctx.get('agentPresets')
      if (presets === undefined) {
        writeJson(res, 200, { presets: [] })
        return
      }
      let rows: ReadonlyArray<{
        id: string; trust: string; name?: string; description?: string; broken?: string
      }>
      try {
        rows = await presets.list()
      } catch (error) {
        writeJson(res, 500, { error: `preset roster failed: ${error instanceof Error ? error.message : String(error)}` })
        return
      }
      let defaultId: string | undefined
      try {
        defaultId = presets.defaultId
      } catch {
        defaultId = undefined
      }
      writeJson(res, 200, {
        ...defaultId === undefined ? {} : { default: defaultId },
        presets: rows.map(row => ({
          id: row.id,
          trust: row.trust,
          ...row.name === undefined ? {} : { name: row.name },
          ...row.description === undefined ? {} : { description: row.description },
          ...row.broken === undefined ? {} : { broken: row.broken },
        })),
      })
    },
  }

  return [jobsRoute, runRoute, workspacesRoute, modelOptionsRoute, presetOptionsRoute]
}
