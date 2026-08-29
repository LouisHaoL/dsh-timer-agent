/**
 * The structural controller face the UI components consume — implemented by
 * the remote controller (host-authoritative edition). Spelled as its own
 * interface so the React tree does not depend on the retired local
 * controller's class.
 */
import type { ControllerSnapshot } from '../core/controller.ts'
import type { JobModelSelection, JobRecord, NewJobInput, SessionTarget } from '../core/jobs.ts'

/** Structural face for TimerBoard / JobDetail / NewJobModal. */
export interface BoardControllerFace {
  getSnapshot(): ControllerSnapshot
  subscribe(fn: () => void): () => void
  openBoard(): void
  closeBoard(): void
  toggleBoard(): void
  openJob(id: string): void
  closeJob(): void
  createJob(input: NewJobInput): Promise<JobRecord | undefined> | JobRecord | undefined
  updateJob(id: string, patch: Partial<Pick<JobRecord, 'title' | 'description' | 'prompt' | 'command' | 'args' | 'preset'>> & { target?: SessionTarget; cron?: string; scheduleEnabled?: boolean; timeoutMinutes?: number; modelSelection?: JobModelSelection | null }): Promise<void> | void
  deleteJob(id: string): Promise<void> | void
  resetJob(id: string): Promise<void> | void
  /** Freeze a job: no schedule fires, no manual runs (host refuses while running). */
  archiveJob(id: string): Promise<void> | void
  /** Un-archive a job back to idle; an armed schedule gets a fresh nextRunAt. */
  restartJob(id: string): Promise<void> | void
  setSchedule(id: string, patch: { enabled?: boolean; cron?: string }): boolean | Promise<boolean>
  /** Skip the next scheduled fire: nextRunAt rolls forward one occurrence. */
  skipNextRun(id: string): Promise<boolean> | boolean
  applyScheduleNextRun(id: string, nextRunAt: number | undefined, lastTriggeredAt: number | undefined): Promise<void> | void
  openSession(sessionId: string): void
  runJob(id: string): Promise<boolean> | boolean
  rerunJob(id: string): Promise<void> | void
  /** Stage a cron for the next createJob (remote controller only; optional). */
  stageCreateCron?(cron: string | undefined): void
}
