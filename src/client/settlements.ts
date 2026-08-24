/**
 * Settlement detection: pure diff over two ledger snapshots that yields the
 * executions which settled between them. The client controller runs this on
 * every poll refresh and turns each event into a desktop notification
 * (OpenClaw RFC #96190 `notifyOnCompletion`; ClaudeCron ships the same as
 * "alerts on task completion"). Pure and framework-free so the transition
 * semantics are unit-testable in plain Node.
 *
 * Rules:
 * - An execution that was unsettled in `prev` (result undefined, still
 *   running) and settled in `next` (result succeeded/failed) emits one
 *   event. Cancelled settle is silent (a deliberate human stop, not news).
 * - Jobs absent from `prev` never emit: the very first poll after page load
 *   must not replay the whole ledger's history as notifications.
 * - Only 'done' / 'failed' job-level results carry; intermediate
 *   executions settling while the job moves straight into another run are
 *   still reported per-execution (each observed settle is news).
 */
import type { JobRecord } from '../core/jobs.ts'

/** One observed execution settlement. */
export interface SettlementEvent {
  jobId: string
  title: string
  /** Job-level outcome label: done | failed. */
  result: 'done' | 'failed'
  /** Failure text when result is failed. */
  error: string | undefined
  /** The session that ran the execution (jump target). */
  sessionId: string | undefined
  /** Settlement instant (ms epoch). */
  endedAt: number
}

/**
 * Diff two ledger snapshots into the settlement events between them.
 * @param prev - the previously observed jobs (may be empty on first poll).
 * @param next - the freshly polled jobs.
 * @returns events in `next`'s job order.
 */
export function detectSettlements(prev: readonly JobRecord[], next: readonly JobRecord[]): SettlementEvent[] {
  const previousById = new Map(prev.map(job => [job.id, job]))
  const events: SettlementEvent[] = []
  for (const job of next) {
    const previous = previousById.get(job.id)
    if (previous === undefined) continue
    const previousExecutions = new Map(previous.executions.map(execution => [execution.id, execution]))
    for (const execution of job.executions) {
      if (execution.result === undefined || execution.endedAt === undefined) continue
      const was = previousExecutions.get(execution.id)
      if (was !== undefined && was.result !== undefined) continue // already settled before
      if (execution.result === 'cancelled') continue // deliberate stop, not news
      events.push({
        jobId: job.id,
        title: job.title,
        result: execution.result === 'succeeded' ? 'done' : 'failed',
        error: execution.error,
        sessionId: execution.sessionId,
        endedAt: execution.endedAt,
      })
    }
  }
  return events
}
