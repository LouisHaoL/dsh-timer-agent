/**
 * Timer x Agent domain model (adapted from hermes-agent cron semantics for
 * the dsh web GUI): job lifecycle statuses, the job record shape, and the
 * pure transition functions the controller shares.
 *
 * Key difference from hermes-agent cron: a job here may target an explicit
 * workspace + session (its prompt is delivered into that existing session),
 * or fall back to "new session in the default workspace" when both targeting
 * fields are blank (the task-board execution default).
 *
 * Framework-free (no cordis, no runtime imports) so the state machine is
 * unit-testable in isolation.
 */

/**
 * Job lifecycle status. 'archived' freezes the job: the ticker skips its
 * schedule and manual runs are refused until it is restarted (back to idle).
 */
export type JobStatus = 'idle' | 'running' | 'done' | 'failed' | 'archived'

/**
 * How a job executes. 'agent' (the default) drives a real dsh agent session
 * with the job's prompt; 'command' spawns the job's command + args directly
 * (no AI, no API quota) — for scripts that simply need a timer.
 */
export type JobKind = 'agent' | 'command'

/** Resolve a job's kind; absent/unknown fields degrade to the 'agent' default. */
export function jobKind(job: Pick<JobRecord, 'kind'>): JobKind {
  return job.kind === 'command' ? 'command' : 'agent'
}

/**
 * One real execution attempt: the run's own id, the dsh session that ran it
 * (filled once the session is created/connected; undefined for command
 * runs), and the settled outcome once the execution ended.
 */
export interface ExecutionRecord {
  /** Execution attempt id (uuid). */
  id: string
  /** The dsh session that ran this attempt; absent until creation resolves. */
  sessionId: string | undefined
  /** How the session was targeted for this attempt ('command' = direct spawn). */
  targeting: 'specified-session' | 'new-session' | 'command'
  /** When the run started (ms epoch). */
  startedAt: number
  /** When the run settled; absent while still running. */
  endedAt: number | undefined
  /** Outcome once settled. */
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  /** Human failure text when the run failed. */
  error: string | undefined
  /** Command runs: the process's exit code (null-ish when killed). */
  exitCode?: number
  /** Command runs: captured stdout+stderr tail for the detail view. */
  output?: string
}

/**
 * A scheduled-run rule attached to a job. The browser-side scheduler ticks
 * every minute and triggers the job when `nextRunAt` is due; the rule is
 * persisted with the job (localStorage), so scheduling survives refreshes.
 */
export interface ScheduleRule {
  /** Whether the schedule is armed. */
  enabled: boolean
  /** 5-field cron expression: `分 时 日 月 周`. */
  cron: string
  /** Next due instant (ms epoch); maintained by the scheduler/controller. */
  nextRunAt: number | undefined
  /** Instant of the latest scheduled trigger (ms epoch). */
  lastTriggeredAt: number | undefined
}

/**
 * Where a job's prompts are delivered (session targeting).
 *
 * `workdir` follows hermes-agent cron's semantics: the project directory the
 * run's terminal/file tools operate in (and whose context files load). Blank
 * → the deployment default (the workspace the host agent would use anyway).
 */
export interface SessionTarget {
  /**
   * Target project directory (canonical absolute path); blank → default
   * workspace.
   */
  workdir: string
  /**
   * Target session id; blank → a NEW session is created in the target
   * workdir for each execution.
   */
  sessionId: string
}

/**
 * Agent-preset id a NEW session is composed from (agent jobs only, and only
 * meaningful while {@link SessionTarget.sessionId} is blank — a pinned
 * session keeps the preset its history was produced under). Absent/blank →
 * the deployment roster default.
 */
export type JobPreset = string

/**
 * Per-job model selection: which provider/model a run uses. Absent → the
 * default resolution (a pinned session keeps its own selection; a new
 * session falls back to the deployment `agentDefaultModel`).
 */
export interface JobModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** One scheduled job on the board. */
export interface JobRecord {
  /** Stable job id (uuid). */
  id: string
  /** Short display title. */
  title: string
  /** Longer human description shown in the detail view. */
  description: string
  /** The prompt sent to the dsh agent when this job fires (agent jobs). */
  prompt: string
  /**
   * Execution kind: 'agent' (default; prompt through a dsh session) or
   * 'command' (spawn {@link command} + {@link args} directly, no AI).
   */
  kind?: JobKind
  /** Command jobs: the executable to spawn (name or absolute path). */
  command?: string
  /** Command jobs: argument string for {@link command} (quote-aware split). */
  args?: string
  /** Current lifecycle status. */
  status: JobStatus
  /** Session targeting (see {@link SessionTarget}). */
  target: SessionTarget
  /**
   * Agent-preset id for NEW sessions (agent jobs with no pinned session);
   * absent/blank → the deployment roster default. Ignored for pinned
   * sessions and command jobs.
   */
  preset?: JobPreset
  /** Model override for runs (absent → default resolution). */
  modelSelection?: JobModelSelection
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /** Every execution attempt, most recent last. */
  executions: ExecutionRecord[]
  /**
   * Pending manual-run request (ms epoch of the request): the host ticker
   * fires it on its next pass (≤ ~5s) and clears the field. This is the
   * browser/tool → host command channel through the shared ledger.
   */
  runRequestedAt?: number
  /**
   * Per-job execution timeout (ms, positive): a run still in flight past
   * its deadline is cancelled and settled failed. Absent/zero → no limit
   * (n8n / cron-job.org parity).
   */
  timeoutMs?: number
  /** Scheduled-run rule (absent on jobs without a schedule). */
  schedule?: ScheduleRule
}

/**
 * Normalize a timeout input (ms) into the stored shape: positive finite
 * numbers pass through (rounded), everything else (0, negative, NaN,
 * non-number) clears the limit.
 */
export function normalizeTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

/** Human timeout label for detail surfaces ('—' when unlimited). */
export function timeoutLabel(job: JobRecord): string {
  if (job.timeoutMs === undefined) return '—'
  if (job.timeoutMs < 60_000) return `${job.timeoutMs / 1000}s`
  const minutes = job.timeoutMs / 60_000
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`
}

/** Input for creating a job. */
export interface NewJobInput {
  title: string
  description: string
  prompt: string
  /** Execution kind; absent → 'agent'. */
  kind?: JobKind
  /** Command jobs: executable to spawn. */
  command?: string
  /** Command jobs: argument string (quote-aware split). */
  args?: string
  target: SessionTarget
  /** Agent-preset id for new sessions (absent/blank → roster default). */
  preset?: JobPreset
  /** Model override for runs (absent → default resolution). */
  modelSelection?: JobModelSelection
}

/** Statuses the runner may settle a card into from 'running'. */
export const RUNNER_SETTLE_STATUSES: readonly JobStatus[] = ['done', 'failed']

/** All valid statuses (closed union guard). */
export const ALL_STATUSES: readonly JobStatus[] = ['idle', 'running', 'done', 'failed', 'archived']

/** Brand an unknown string as a status; undefined when it is not one. */
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/** Create a job from user input. */
export function createJob(input: NewJobInput, now: number, id: string): JobRecord {
  const kind = jobKind(input)
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    ...(kind === 'command' ? {
      kind,
      command: (input.command ?? '').trim(),
      args: (input.args ?? '').trim(),
    } : {}),
    status: 'idle',
    target: { ...input.target },
    ...(kind === 'agent' && input.preset !== undefined && input.preset.trim() !== ''
      ? { preset: input.preset.trim() }
      : {}),
    ...input.modelSelection === undefined ? {} : { modelSelection: { ...input.modelSelection } },
    createdAt: now,
    updatedAt: now,
    executions: [],
  }
}

/** A command job's display/exec line: `command args` (agent jobs → ''). */
export function commandLine(job: Pick<JobRecord, 'kind' | 'command' | 'args'>): string {
  if (jobKind(job) !== 'command') return ''
  return `${job.command ?? ''} ${job.args ?? ''}`.trim()
}

/** Clone a job with an updated status and a fresh updatedAt. */
export function withStatus(job: JobRecord, status: JobStatus, now: number): JobRecord {
  return { ...job, status, updatedAt: now }
}

/**
 * Stamp (or clear) a manual-run request. The host ticker consumes it.
 */
export function withRunRequest(job: JobRecord, requestedAt: number | undefined, now: number): JobRecord {
  const next = { ...job, updatedAt: now }
  if (requestedAt === undefined) delete next.runRequestedAt
  else next.runRequestedAt = requestedAt
  return next
}

/**
 * Merge a schedule patch into a job's schedule rule (creating it when
 * absent), with a fresh updatedAt. Keys present in the patch overwrite the
 * current value — including explicit `undefined`, which clears a field.
 */
export function withSchedule(
  job: JobRecord,
  patch: Partial<ScheduleRule>,
  now: number,
): JobRecord {
  const current = job.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  return { ...job, updatedAt: now, schedule }
}

/**
 * Open a fresh execution on a job: move it to 'running' and append a running
 * execution record. Returns the new job and the new execution.
 */
export function startExecution(
  job: JobRecord,
  now: number,
  executionId: string,
  targeting: ExecutionRecord['targeting'],
): { job: JobRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    sessionId: undefined,
    targeting,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
  }
  return {
    job: { ...job, status: 'running', updatedAt: now, executions: [...job.executions, execution] },
    execution,
  }
}

/**
 * Settle a running execution: record the outcome and move the job into the
 * matching column. No-op when the execution is not the job's latest or is
 * already settled.
 */
export function settleExecution(
  job: JobRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  now: number,
  error: string | undefined,
  extra?: { exitCode?: number, output?: string },
): JobRecord {
  const index = job.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return job
  const execution = job.executions[index]
  if (execution.endedAt !== undefined) return job
  const settled: ExecutionRecord = {
    ...execution,
    endedAt: now,
    result: outcome,
    error,
    ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra?.output !== undefined ? { output: extra.output } : {}),
  }
  const executions = [...job.executions]
  executions[index] = settled
  const status: JobStatus = outcome === 'succeeded' ? 'done'
    : outcome === 'failed' ? 'failed'
      : job.status === 'running' ? 'idle' : job.status
  return { ...job, status, updatedAt: now, executions }
}

/** A settled-execution summary string for the detail view. */
export function executionLabel(execution: ExecutionRecord): string {
  if (execution.result === 'succeeded') return 'succeeded'
  if (execution.result === 'failed') return 'failed'
  if (execution.result === 'cancelled') return 'cancelled'
  return 'running'
}
