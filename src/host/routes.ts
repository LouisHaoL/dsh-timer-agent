/**
 * The /api/dsh-timer-agent route family: the browser half's read/write
 * window onto the host-authoritative ledger. Every route carries the same
 * loopback-only trust fence dsh-ssh uses (these endpoints can fire real
 * agent sessions, so LAN-exposed dsh web deployments must not serve them).
 *
 * - GET    /api/dsh-timer-agent/jobs          → the full ledger
 * - POST   /api/dsh-timer-agent/jobs          → create a job
 * - PATCH  /api/dsh-timer-agent/jobs?id=…     → update fields / arm cron
 * - DELETE /api/dsh-timer-agent/jobs?id=…     → remove
 * - POST   /api/dsh-timer-agent/jobs/run?id=… → fire now (background)
 * - GET    /api/dsh-timer-agent/workspaces    → host workspace registry {id,path}
 *
 * @module dsh-timer-agent/routes
 */
import { randomUUID } from 'node:crypto'
import type {
  HostPluginContext, HostRoute, NodeIncomingMessage, NodeServerResponse,
} from './contracts.ts'
import { isValidCron, nextRunAtMs } from '../core/schedule.ts'
import { createJob, withSchedule, withStatus, type JobRecord } from '../core/jobs.ts'
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
        const target = (typeof body.target === 'object' && body.target !== null ? body.target : {}) as Record<string, unknown>
        let job = createJob({
          title,
          description: typeof body.description === 'string' ? body.description : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          target: {
            workdir: typeof target.workdir === 'string' ? target.workdir.trim() : '',
            sessionId: typeof target.sessionId === 'string' ? target.sessionId.trim() : '',
          },
        }, deps.now(), randomUUID())
        if (armCron) {
          job = withSchedule(job, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, deps.now()) }, deps.now())
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
          if (typeof body.cron === 'string' && body.cron.trim() !== '') {
            const cron = body.cron.trim()
            if (!isValidCron(cron)) return undefined
            next = withSchedule(next, { cron }, deps.now())
          }
          if (body.scheduleEnabled === true) {
            const cron = next.schedule?.cron ?? ''
            if (!isValidCron(cron)) return undefined
            next = withSchedule(next, { enabled: true, nextRunAt: nextRunAtMs(cron, deps.now()) }, deps.now())
          }
          if (body.scheduleEnabled === false) {
            next = withSchedule(next, { enabled: false, nextRunAt: undefined }, deps.now())
          }
          if (body.resetStatus === true) next = withStatus(next, 'idle', deps.now())
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

  return [jobsRoute, runRoute, workspacesRoute]
}
