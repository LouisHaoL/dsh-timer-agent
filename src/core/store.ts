/**
 * Job persistence: a small storage seam with a localStorage backend.
 * (Same persistence mechanism dsh's own client snapshot stores use; the
 * browser has no dsh-writable file channel — the task-board / skin-center
 * research conclusion.)
 *
 * The seam keeps the backend swappable (e.g. an IndexedDB or a host-file
 * channel later); validation repairs malformed rows field by field.
 */
import { isIntervalRule, isValidCron } from './schedule.ts'
import type { ExecutionRecord, JobRecord, JobStatus, ScheduleRule, SessionTarget } from './jobs.ts'
import { isJobStatus } from './jobs.ts'

/** Persistence seam for the job ledger. */
export interface JobStore {
  /** Read the persisted ledger (empty when nothing is stored yet). */
  load(): JobRecord[]
  /** Persist the whole ledger (replaces the stored document). */
  save(jobs: readonly JobRecord[]): void
  /** Drop the persisted ledger (leaves the in-memory state alone). */
  clear(): void
}

/** Storage key for the job ledger document. */
export const DEFAULT_STORAGE_KEY = 'dsh.timerAgent.v1'

/** Structural row check with the status left unvalidated (normalized later). */
function isJobRecordShape(value: unknown): value is Omit<JobRecord, 'status'> & { status: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return false
  if (typeof record.title !== 'string') return false
  if (typeof record.description !== 'string') return false
  if (typeof record.prompt !== 'string') return false
  if (record.kind !== undefined && record.kind !== 'agent' && record.kind !== 'command') return false
  if (record.command !== undefined && typeof record.command !== 'string') return false
  if (record.args !== undefined && typeof record.args !== 'string') return false
  if (typeof record.createdAt !== 'number') return false
  if (typeof record.updatedAt !== 'number') return false
  const target = record.target
  if (typeof target !== 'object' || target === null) return false
  const t = target as Record<string, unknown>
  if (typeof t.workdir !== 'string' || typeof t.sessionId !== 'string') return false
  if (!Array.isArray(record.executions)) return false
  for (const execution of record.executions) {
    if (!isExecutionShape(execution)) return false
  }
  return true
}

function isExecutionShape(value: unknown): value is ExecutionRecord {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string') return false
  if (entry.sessionId !== undefined && typeof entry.sessionId !== 'string') return false
  if (entry.targeting !== 'specified-session' && entry.targeting !== 'new-session' && entry.targeting !== 'command') return false
  if (typeof entry.startedAt !== 'number') return false
  if (entry.endedAt !== undefined && typeof entry.endedAt !== 'number') return false
  if (entry.result !== undefined && entry.result !== 'succeeded' && entry.result !== 'failed' && entry.result !== 'cancelled') return false
  if (entry.error !== undefined && typeof entry.error !== 'string') return false
  if (entry.exitCode !== undefined && typeof entry.exitCode !== 'number') return false
  if (entry.output !== undefined && typeof entry.output !== 'string') return false
  return true
}

/** Normalize an unknown persisted status back into the closed union. */
function normalizeStatus(status: unknown): JobStatus {
  return isJobStatus(status) ? status : 'idle'
}

/**
 * Repair a persisted schedule rule: keep cron rules with a usable expression
 * and fixed-interval rules (intervalMinutes > 0, cron then ''); coerce
 * booleans; leave `nextRunAt`/`lastTriggeredAt` undefined when missing.
 */
function normalizeSchedule(schedule: unknown): ScheduleRule | undefined {
  if (typeof schedule !== 'object' || schedule === null) return undefined
  const rule = schedule as Record<string, unknown>
  if (typeof rule.cron !== 'string') return undefined
  // Fixed-interval mode: intervalMinutes > 0 replaces cron as the schedulable
  // field (an interval job has cron === '' and must not be dropped here).
  const intervalMinutes = typeof rule.intervalMinutes === 'number' && rule.intervalMinutes > 0
    ? Math.round(rule.intervalMinutes)
    : undefined
  if (!isIntervalRule({ intervalMinutes }) && (rule.cron.trim() === '' || !isValidCron(rule.cron))) return undefined
  return {
    enabled: rule.enabled === true && (rule.cron.trim() !== '' || intervalMinutes !== undefined),
    cron: intervalMinutes !== undefined ? '' : rule.cron,
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
    nextRunAt: typeof rule.nextRunAt === 'number' ? rule.nextRunAt : undefined,
    lastTriggeredAt: typeof rule.lastTriggeredAt === 'number' ? rule.lastTriggeredAt : undefined,
  }
}

/** Parse + validate a persisted ledger document; invalid rows are dropped. */
export function parseLedger(raw: string | null): JobRecord[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error('[dsh-timer-agent] persisted job ledger is not valid JSON; starting empty', error)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.error('[dsh-timer-agent] persisted job ledger is not an array; starting empty')
    return []
  }
  const jobs: JobRecord[] = []
  for (const row of parsed) {
    if (!isJobRecordShape(row)) {
      console.warn('[dsh-timer-agent] dropping invalid job row from persisted ledger', row)
      continue
    }
    const job: JobRecord = { ...row, status: normalizeStatus(row.status) }
    // Command rows keep their kind + exec fields; agent rows stay lean
    // (an absent kind IS the agent default, matching pre-0.2 ledgers).
    if (row.kind !== 'command') {
      delete job.kind
      delete job.command
      delete job.args
    }
    job.target = normalizeTarget(row.target)
    job.schedule = normalizeSchedule(row.schedule)
    jobs.push(job)
  }
  return jobs
}

/** Clamp a persisted target to the known shape (unknown → blank/blank). */
function normalizeTarget(target: SessionTarget): SessionTarget {
  return {
    workdir: typeof target.workdir === 'string' ? target.workdir : '',
    sessionId: typeof target.sessionId === 'string' ? target.sessionId : '',
  }
}

/** localStorage-backed store (the browser backend). */
export class LocalStorageJobStore implements JobStore {
  /**
   * @param key - storage key for the ledger document.
   * @param storage - storage backend (defaults to the global localStorage).
   */
  constructor(
    private readonly key: string = DEFAULT_STORAGE_KEY,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
  ) {}

  load(): JobRecord[] {
    if (this.storage === undefined) return []
    try {
      return parseLedger(this.storage.getItem(this.key))
    } catch (error) {
      console.error('[dsh-timer-agent] job ledger read failed; starting empty', error)
      return []
    }
  }

  save(jobs: readonly JobRecord[]): void {
    if (this.storage === undefined) return
    try {
      this.storage.setItem(this.key, JSON.stringify(jobs))
    } catch (error) {
      console.error('[dsh-timer-agent] job ledger write failed (persistence skipped)', error)
    }
  }

  clear(): void {
    if (this.storage === undefined) return
    try {
      this.storage.removeItem(this.key)
    } catch (error) {
      console.error('[dsh-timer-agent] job ledger clear failed', error)
    }
  }
}

/** In-memory backend (tests, and a fallback when storage is unavailable). */
export class InMemoryJobStore implements JobStore {
  private ledger: JobRecord[] = []

  load(): JobRecord[] {
    return this.ledger.map(job => ({ ...job, executions: [...job.executions] }))
  }

  save(jobs: readonly JobRecord[]): void {
    this.ledger = jobs.map(job => ({ ...job, executions: [...job.executions] }))
  }

  clear(): void {
    this.ledger = []
  }
}
