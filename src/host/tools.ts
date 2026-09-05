/**
 * The `timer_agent` model-facing tool (the hermes `cronjob` tool's shape):
 * lets any conversation create/list/update/pause/resume/remove/run the
 * scheduled jobs the host ticker owns. Jobs created here are the SAME rows
 * the web UI's「定时任务」panel renders and the host ticker fires — one
 * ledger, three doorways (tool, WebUI, file).
 *
 * @module dsh-timer-agent/tools
 */
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { isIntervalRule, isSchedulable, isValidCron, nextRunAtMs, scheduleNextMs } from '../core/schedule.ts'
import {
  createJob, jobKind, normalizeTimeoutMs, withSchedule, withStatus, withRunRequest,
  type JobRecord,
} from '../core/jobs.ts'
import type { HostJobStore } from './store.ts'
import type { TimerRunner } from './runner.ts'

/** Tool output shape. */
interface TimerToolOutput {
  kind: string
  error?: string
  job?: JsonValue
  jobs?: JsonValue[]
}

/** Structural deps handed in by the plugin entry. */
export interface TimerToolDeps {
  store: HostJobStore
  runner: TimerRunner
  now(): number
}

/** One job row summarized for the model (compact, no execution history dump). */
function summarize(job: JobRecord): JsonValue {
  const last = job.executions[job.executions.length - 1]
  const result: Record<string, JsonValue> = {
    id: job.id,
    title: job.title,
    status: job.status,
    job_kind: jobKind(job),
  }
  if (jobKind(job) === 'command') {
    result.command = job.command ?? ''
    result.args = job.args ?? ''
    if (job.target.workdir !== '') result.workdir = job.target.workdir
  } else {
    result.target = job.target.sessionId !== ''
      ? { session: job.target.sessionId }
      : { workdir: job.target.workdir === '' ? '(default workspace)' : job.target.workdir, mode: 'new-session' }
    if (job.target.sessionId === '' && job.preset !== undefined && job.preset !== '') {
      result.preset = job.preset
    }
  }
  // NOTE: every optional field must be added conditionally — an explicit
  // `undefined` property value fails the host's lossless-JSON tool-output
  // validation (JSON.stringify would silently drop it, the validator does not).
  if (job.schedule?.enabled === true) {
    // Fixed-interval mode: interval_minutes replaces cron as the schedulable field.
    const schedule: Record<string, JsonValue> = isIntervalRule(job.schedule)
      ? { interval_minutes: job.schedule.intervalMinutes! }
      : { cron: job.schedule.cron }
    if (job.schedule.nextRunAt !== undefined) schedule.next_run_at = new Date(job.schedule.nextRunAt).toISOString()
    result.schedule = schedule
  }
  if (job.timeoutMs !== undefined) result.timeout_minutes = Math.round(job.timeoutMs / 60_000)
  if (last !== undefined) {
    const lastExecution: Record<string, JsonValue> = {
      result: last.result ?? 'running',
      at: new Date(last.startedAt).toISOString(),
    }
    if (jobKind(job) !== 'command' && last.sessionId !== undefined) lastExecution.session = last.sessionId
    if (last.exitCode !== undefined) lastExecution.exit_code = last.exitCode
    result.last_execution = lastExecution
  }
  return result as JsonValue
}

/**
 * Register the `timer_agent` tool into the shared tools registry.
 * @param tools - the injected `tools` registry.
 * @param deps - store/runner/clock faces.
 * @returns the disposer.
 */
export function registerTimerTool(tools: { register(def: unknown): () => void }, deps: TimerToolDeps): () => void {
  return tools.register(defineTool({
    name: 'timer_agent',
    description: [
      'Manage scheduled timer jobs that fire on a cron schedule (the dsh-timer-agent engine; the same jobs appear in the web GUI「定时任务」panel).',
      "Two job kinds: kind='agent' (default) fires a real agent session from a self-contained prompt; kind='command' (普通任务) directly spawns command+args with no AI — use it for scripts that just need a timer.",
      "action='create' schedules a new job (requires schedule; agent jobs also require prompt — self-contained, scheduled runs get no current-chat context unless session is pinned; command jobs require command instead).",
      "action='list' shows all jobs; action='update' edits prompt/schedule/name/command/args; action='pause'/'resume' arms/disarms the schedule; action='archive' freezes a job (no schedule fires, no manual runs) and action='restart' un-archives it back to idle; action='remove' deletes; action='run' fires immediately in the background (returns at once).",
      "schedule syntax: 5-field cron like '0 9 * * *' (min hour day month weekday), OR pass interval_minutes instead for a fixed interval from the last trigger (e.g. every 302 minutes — a cadence a cron grid cannot express).",
      "session targeting (agent jobs only): leave both workdir and session empty → each run starts a NEW conversation in the default workspace; pass session=<existing session id> → every run continues that conversation (continuity); pass workdir=<absolute project path> → new sessions run inside that project. For command jobs, workdir is the process cwd.",
      "preset (agent jobs with new sessions only): the agent-preset id new sessions are composed from (its tools/prompt sections/skills); empty = the deployment default. Ignored when session is pinned.",
      'Scheduled runs execute autonomously with no user present — prompts must not ask questions.',
    ].join('\n'),
    timeoutMs: 15000,
    parameters: {
      action: {
        type: 'string',
        description: 'One of: create, list, update, pause, resume, archive, restart, remove, run. Required.',
      },
      job_id: {
        type: 'string',
        description: 'Job id (required for update/pause/resume/archive/restart/remove/run). Get ids from action=list; never guess.',
      },
      prompt: {
        type: 'string',
        description: "For create: the full self-contained prompt the scheduled run executes (agent jobs only; required unless kind='command'). For update: replacement prompt. For run: optional transient context appended for this single fire only.",
      },
      kind: {
        type: 'string',
        description: "For create/update: job kind — 'agent' (default; AI session executes prompt) or 'command' (普通任务; spawns command+args directly, no AI).",
      },
      command: {
        type: 'string',
        description: "For create/update (kind='command'): the executable to spawn, e.g. 'pwsh', 'python', 'node', or an absolute path. Required for command jobs.",
      },
      args: {
        type: 'string',
        description: "For create/update (kind='command'): argument string for the command; whitespace-separated, supports \"double\"/'single' quoted groups. E.g. '-X utf8 temu_yh_yinhua.py' or '-Command \"echo hi\"'.",
      },
      schedule: {
        type: 'string',
        description: "For create (required unless interval_minutes is set) / update: 5-field cron, e.g. '0 9 * * *' daily at 9am, '*/30 * * * *' every 30 minutes. Setting it switches the job back to cron mode from interval mode.",
      },
      interval_minutes: {
        type: 'number',
        description: 'For create/update: fixed-interval alternative to schedule — fire every N minutes measured from the last trigger (> 0 switches to interval mode, clearing cron; 0 or negative switches back to cron mode). Use for cadences cron cannot express, e.g. every 302 minutes.',
      },
      name: {
        type: 'string',
        description: 'For create/update: short human title.',
      },
      workdir: {
        type: 'string',
        description: "For create/update: absolute project directory the run's session works in (its AGENTS.md loads). Empty = default workspace. Pass empty string on update to clear.",
      },
      session: {
        type: 'string',
        description: 'For create/update: pin an existing session id — every run continues that conversation instead of starting new ones. Pass empty string on update to clear.',
      },
      preset: {
        type: 'string',
        description: "For create/update (agent jobs, new sessions only): agent-preset id the new sessions are composed from (its tools/prompt sections/skills); empty = the deployment default preset. Ignored when session is pinned. Pass empty string on update to clear.",
      },
      timeout_minutes: {
        type: 'number',
        description: 'For create/update: cancel and fail a run still in flight after this many minutes (0 or negative clears the limit). Absent = unlimited.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          job: { type: 'json' },
          jobs: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value.error === 'string' && value.error !== ''
          ? `timer_agent ${String(value.kind)}: ${value.error}`
          : `timer_agent ${String(value.kind)} ok${value.job !== undefined ? `: ${JSON.stringify(value.job)}` : value.jobs !== undefined ? `: ${String((value.jobs as JsonValue[]).length)} job(s)` : ''}`,
      }],
    },
    async execute(args: {
      action?: string
      job_id?: string
      prompt?: string
      kind?: string
      command?: string
      args?: string
      schedule?: string
      interval_minutes?: number
      name?: string
      workdir?: string
      session?: string
      preset?: string
      timeout_minutes?: number
    }): Promise<TimerToolOutput> {
      const action = (args.action ?? '').trim().toLowerCase()
      const now = deps.now

      if (action === 'list') {
        const jobs = await deps.store.load()
        return { kind: 'list', jobs: jobs.map(summarize) }
      }

      if (action === 'create') {
        const cron = (args.schedule ?? '').trim()
        const intervalMinutes = typeof args.interval_minutes === 'number' && args.interval_minutes > 0
          ? Math.round(args.interval_minutes)
          : undefined
        const prompt = (args.prompt ?? '').trim()
        const kind = args.kind === 'command' ? 'command' : 'agent'
        const command = (args.command ?? '').trim()
        if (cron === '' && intervalMinutes === undefined) return { kind: 'create', error: 'schedule (cron) or interval_minutes is required for create' }
        if (cron !== '' && !isValidCron(cron)) return { kind: 'create', error: `invalid cron expression: ${cron}` }
        if (kind === 'command') {
          if (command === '') return { kind: 'create', error: "command is required for create with kind='command'" }
        } else if (prompt === '') {
          return { kind: 'create', error: 'prompt is required for create (must be self-contained)' }
        }
        const fallbackTitle = kind === 'command' ? `${command} ${(args.args ?? '').trim()}`.trim().slice(0, 40) : prompt.slice(0, 40)
        const title = (args.name ?? '').trim() !== '' ? (args.name ?? '').trim() : fallbackTitle
        const job = createJob({
          title,
          description: '',
          prompt,
          ...(kind === 'command' ? { kind: 'command' as const, command, args: (args.args ?? '').trim() } : {}),
          target: { workdir: (args.workdir ?? '').trim(), sessionId: (args.session ?? '').trim() },
          ...(kind === 'agent' && (args.preset ?? '').trim() !== '' ? { preset: (args.preset ?? '').trim() } : {}),
        }, now(), randomUUID())
        const timeoutMs = normalizeTimeoutMs((args.timeout_minutes ?? 0) * 60_000)
        const withTimeout = timeoutMs === undefined ? job : { ...job, timeoutMs }
        const scheduled = intervalMinutes !== undefined
          ? withSchedule(withTimeout, { enabled: true, intervalMinutes, nextRunAt: now() + intervalMinutes * 60_000 }, now())
          : withSchedule(withTimeout, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, now()) }, now())
        await deps.store.mutate(jobs => ({ jobs: [...jobs, scheduled], result: true }))
        return { kind: 'create', job: summarize(scheduled) }
      }

      if (action === 'run') {
        const id = (args.job_id ?? '').trim()
        if (id === '') return { kind: 'run', error: 'job_id is required for run (use list to find ids)' }
        const extra = args.prompt
        const accepted = await deps.runner.requestRun(id, extra)
        if (!accepted) return { kind: 'run', error: `job ${id} not found or already running` }
        return { kind: 'run', job: { id, note: 'fired in the background; its session appears in the session list' } }
      }

      // update / pause / resume / remove all need an existing job
      const id = (args.job_id ?? '').trim()
      if (id === '') return { kind: action, error: 'job_id is required (use list to find ids)' }

      if (action === 'remove') {
        const removed = await deps.store.mutate(jobs => {
          if (!jobs.some(job => job.id === id)) return undefined
          return { jobs: jobs.filter(job => job.id !== id), result: true }
        })
        if (removed === undefined) return { kind: 'remove', error: `job ${id} not found` }
        return { kind: 'remove', job: { id } }
      }

      if (action === 'pause' || action === 'resume') {
        const enabled = action === 'resume'
        const updated = await deps.store.mutate(jobs => {
          const job = jobs.find(candidate => candidate.id === id)
          if (job === undefined || job.schedule === undefined) return undefined
          if (enabled && !isSchedulable(job.schedule)) return undefined
          const nextRunAt = enabled
            ? (isIntervalRule(job.schedule)
              ? now() + job.schedule.intervalMinutes! * 60_000
              : nextRunAtMs(job.schedule.cron, now()))
            : undefined
          const next = withSchedule(job, { enabled, nextRunAt }, now())
          return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
        })
        if (updated === undefined) return { kind: action, error: `job ${id} not found or has no usable schedule` }
        return { kind: action, job: summarize(updated) }
      }

      if (action === 'update') {
        const updated = await deps.store.mutate(jobs => {
          const job = jobs.find(candidate => candidate.id === id)
          if (job === undefined) return undefined
          let next: JobRecord = { ...job, updatedAt: now() }
          if (args.name !== undefined && args.name.trim() !== '') next = { ...next, title: args.name.trim() }
          if (args.prompt !== undefined && args.prompt.trim() !== '') next = { ...next, prompt: args.prompt.trim() }
          if (args.workdir !== undefined) next = { ...next, target: { ...next.target, workdir: args.workdir.trim() } }
          if (args.session !== undefined) next = { ...next, target: { ...next.target, sessionId: args.session.trim() } }
          // Preset pin/clear (agent jobs; pinned sessions ignore it).
          if (args.preset !== undefined) {
            const preset = args.preset.trim()
            next = { ...next }
            if (preset === '' || jobKind(next) === 'command') delete next.preset
            else next.preset = preset
          }
          // Kind switch (agent ↔ command): rebase the execution fields so the
          // row stays coherent with its new kind.
          if (args.kind !== undefined) {
            const kind = args.kind.trim().toLowerCase()
            if (kind !== 'agent' && kind !== 'command') return undefined
            if (kind === 'command') {
              const command = (args.command ?? next.command ?? '').trim()
              if (command === '') return undefined
              next = { ...next, kind: 'command', command, args: (args.args ?? next.args ?? '').trim() }
            } else {
              next = { ...next }
              delete next.kind
              delete next.command
              delete next.args
            }
          } else if (args.command !== undefined || args.args !== undefined) {
            // Editing a command job's exec line requires the command kind.
            if (jobKind(next) !== 'command') return undefined
            const command = args.command !== undefined ? args.command.trim() : (next.command ?? '')
            if (command === '') return undefined
            next = { ...next, kind: 'command', command, args: args.args !== undefined ? args.args.trim() : (next.args ?? '') }
          }
          if (args.timeout_minutes !== undefined) {
            const timeoutMs = normalizeTimeoutMs(args.timeout_minutes * 60_000)
            if (timeoutMs === undefined) delete next.timeoutMs
            else next = { ...next, timeoutMs }
          }
          if (args.interval_minutes !== undefined) {
            // > 0 → interval mode (cron cleared); <= 0 → back to cron mode.
            const intervalMinutes = args.interval_minutes > 0 ? Math.round(args.interval_minutes) : undefined
            next = withSchedule(next, { intervalMinutes }, now())
            if (next.schedule?.enabled === true && intervalMinutes !== undefined) {
              next = withSchedule(next, { nextRunAt: scheduleNextMs(next.schedule, now()) }, now())
            }
          }
          if (args.schedule !== undefined) {
            const cron = args.schedule.trim()
            if (cron === '') return undefined
            if (!isValidCron(cron)) return undefined
            const wasEnabled = next.schedule?.enabled ?? false
            // An explicit cron clears interval mode.
            next = withSchedule(next, {
              cron,
              intervalMinutes: undefined,
              ...(wasEnabled ? { enabled: true, nextRunAt: nextRunAtMs(cron, now()) } : {}),
            }, now())
          }
          if (next.title === job.title && next.prompt === job.prompt && next.target === job.target && next.schedule === job.schedule) {
            // nothing changed; still accept (idempotent)
          }
          return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
        })
        if (updated === undefined) return { kind: 'update', error: `job ${id} not found or invalid fields` }
        return { kind: 'update', job: summarize(updated) }
      }

      // Manual status reset (idle) — small ergonomic extra.
      if (action === 'reset') {
        const updated = await deps.store.mutate(jobs => {
          const job = jobs.find(candidate => candidate.id === id)
          if (job === undefined) return undefined
          const next = withStatus(job, 'idle', now())
          return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
        })
        if (updated === undefined) return { kind: 'reset', error: `job ${id} not found` }
        return { kind: 'reset', job: summarize(updated) }
      }

      // Archive freezes (no schedule fires, no manual runs); restart un-archives.
      if (action === 'archive' || action === 'restart') {
        const updated = await deps.store.mutate(jobs => {
          const job = jobs.find(candidate => candidate.id === id)
          if (job === undefined) return undefined
          if (action === 'archive') {
            if (job.status === 'running') return undefined
            const next = withStatus(job, 'archived', now())
            return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
          }
          if (job.status !== 'archived') return undefined
          let next = withStatus(job, 'idle', now())
          if (next.schedule?.enabled === true && isSchedulable(next.schedule)) {
            const armed = isIntervalRule(next.schedule)
              ? now() + next.schedule.intervalMinutes! * 60_000
              : nextRunAtMs(next.schedule.cron, now())
            next = withSchedule(next, { enabled: true, nextRunAt: armed }, now())
          }
          return { jobs: jobs.map(candidate => (candidate.id === id ? next : candidate)), result: next }
        })
        if (updated === undefined) {
          return {
            kind: action,
            error: action === 'archive'
              ? `job ${id} not found or currently running`
              : `job ${id} not found or not archived`,
          }
        }
        return { kind: action, job: summarize(updated) }
      }

      return { kind: action, error: `unknown action: ${action}` }
    },
  }))
}

// Re-export so the entry can hand the request stamping to the routes layer.
export { withRunRequest }
