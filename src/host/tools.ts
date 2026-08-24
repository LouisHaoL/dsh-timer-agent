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
import { isValidCron, nextRunAtMs } from '../core/schedule.ts'
import { createJob, withSchedule, withStatus, withRunRequest, type JobRecord } from '../core/jobs.ts'
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
  const schedule = job.schedule?.enabled === true
    ? { cron: job.schedule.cron, next_run_at: job.schedule.nextRunAt !== undefined ? new Date(job.schedule.nextRunAt).toISOString() : undefined }
    : undefined
  const result: Record<string, JsonValue> = {
    id: job.id,
    title: job.title,
    status: job.status,
    target: job.target.sessionId !== ''
      ? { session: job.target.sessionId }
      : { workdir: job.target.workdir === '' ? '(default workspace)' : job.target.workdir, mode: 'new-session' },
  }
  if (schedule !== undefined) result.schedule = schedule as JsonValue
  if (last !== undefined) {
    result.last_execution = {
      result: last.result ?? 'running',
      at: new Date(last.startedAt).toISOString(),
      session: last.sessionId,
    } as JsonValue
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
      'Manage scheduled timer jobs that fire real agent sessions on a cron schedule (the dsh-timer-agent engine; the same jobs appear in the web GUI「定时任务」panel).',
      "action='create' schedules a new job (requires schedule + prompt; prompt must be self-contained — scheduled runs get no current-chat context unless session is pinned).",
      "action='list' shows all jobs; action='update' edits prompt/schedule/name; action='pause'/'resume' arms/disarms the schedule; action='archive' freezes a job (no schedule fires, no manual runs) and action='restart' un-archives it back to idle; action='remove' deletes; action='run' fires immediately in the background (returns at once; the run happens in its own session).",
      "schedule syntax: 5-field cron like '0 9 * * *' (min hour day month weekday).",
      "session targeting: leave both workdir and session empty → each run starts a NEW conversation in the default workspace; pass session=<existing session id> → every run continues that conversation (continuity); pass workdir=<absolute project path> → new sessions run inside that project.",
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
        description: "For create: the full self-contained prompt the scheduled run executes. For update: replacement prompt. For run: optional transient context appended for this single fire only.",
      },
      schedule: {
        type: 'string',
        description: "For create (required) / update: 5-field cron, e.g. '0 9 * * *' daily at 9am, '*/30 * * * *' every 30 minutes.",
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
      schedule?: string
      name?: string
      workdir?: string
      session?: string
    }): Promise<TimerToolOutput> {
      const action = (args.action ?? '').trim().toLowerCase()
      const now = deps.now

      if (action === 'list') {
        const jobs = await deps.store.load()
        return { kind: 'list', jobs: jobs.map(summarize) }
      }

      if (action === 'create') {
        const cron = (args.schedule ?? '').trim()
        const prompt = (args.prompt ?? '').trim()
        if (cron === '') return { kind: 'create', error: 'schedule is required for create' }
        if (!isValidCron(cron)) return { kind: 'create', error: `invalid cron expression: ${cron}` }
        if (prompt === '') return { kind: 'create', error: 'prompt is required for create (must be self-contained)' }
        const title = (args.name ?? '').trim() !== '' ? (args.name ?? '').trim() : prompt.slice(0, 40)
        const job = createJob({
          title,
          description: '',
          prompt,
          target: { workdir: (args.workdir ?? '').trim(), sessionId: (args.session ?? '').trim() },
        }, now(), randomUUID())
        const scheduled = withSchedule(job, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, now()) }, now())
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
          const cron = job.schedule?.cron ?? ''
          if (enabled && !isValidCron(cron)) return undefined
          const next = withSchedule(job, {
            enabled,
            nextRunAt: enabled ? nextRunAtMs(cron, now()) : undefined,
          }, now())
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
          if (args.schedule !== undefined) {
            const cron = args.schedule.trim()
            if (cron === '') return undefined
            if (!isValidCron(cron)) return undefined
            const wasEnabled = next.schedule?.enabled ?? false
            next = withSchedule(next, {
              cron,
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
          const cron = next.schedule?.cron ?? ''
          if (next.schedule?.enabled === true && isValidCron(cron)) {
            next = withSchedule(next, { enabled: true, nextRunAt: nextRunAtMs(cron, now()) }, now())
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
