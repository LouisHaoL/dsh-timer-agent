/**
 * Remote controller: the browser-side BoardController face over the host's
 * /api/dsh-timer-agent routes. The host ledger is authoritative; this
 * controller keeps a polled mirror, forwards every mutation as a precise
 * HTTP call, and refreshes immediately after each one.
 *
 * Implements the same surface the UI components consumed from the old local
 * controller (TimerBoard / JobDetail / NewJobModal), so the React tree is
 * unchanged. `applyScheduleNextRun` is a deliberate no-op: schedule rolling
 * is host-owned now.
 */
import type {
  ControllerSnapshot, SessionsControllerFace,
} from '../core/controller.ts'
import type { JobRecord, NewJobInput, SessionTarget } from '../core/jobs.ts'

/** The sessions navigation face (ctx.sessions.open for transcript jumps). */
export type { SessionsControllerFace }

/** Poll cadence for the ledger mirror. */
const POLL_MS = 5_000

/**
 * Browser controller over the host routes.
 */
export class RemoteBoardController {
  private jobs: JobRecord[] = []
  private boardOpen = false
  private selectedJobId: string | undefined
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private refreshInFlight = false

  /**
   * @param sessions - navigation face (open a session transcript).
   */
  constructor(private readonly sessions: SessionsControllerFace) {}

  // --- lifecycle -------------------------------------------------------------

  /** Start the polling mirror. */
  start(): void {
    void this.refresh()
    this.pollTimer = setInterval(() => { void this.refresh() }, POLL_MS)
  }

  /** Stop polling and drop listeners (idempotent). */
  dispose(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.listeners.clear()
  }

  // --- snapshot / subscription ------------------------------------------------

  getSnapshot(): ControllerSnapshot {
    return {
      jobs: this.jobs,
      boardOpen: this.boardOpen,
      selectedJobId: this.selectedJobId,
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  // --- view state -------------------------------------------------------------

  openBoard(): void {
    if (this.boardOpen) return
    this.boardOpen = true
    this.notify()
    void this.refresh()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.notify()
  }

  toggleBoard(): void {
    if (this.boardOpen) this.closeBoard()
    else this.openBoard()
  }

  openJob(id: string): void {
    if (this.jobs.some(job => job.id === id)) {
      this.selectedJobId = id
      this.notify()
    }
  }

  closeJob(): void {
    if (this.selectedJobId === undefined) return
    this.selectedJobId = undefined
    this.notify()
  }

  // --- job mutations (all forwarded to the host) -------------------------------

  async createJob(input: NewJobInput): Promise<JobRecord | undefined> {
    const title = input.title.trim()
    if (title === '') return undefined
    const cron = this.pendingCreateCron
    const response = await this.fetchJson('POST', '/api/dsh-timer-agent/jobs', {
      title,
      description: input.description,
      prompt: input.prompt,
      target: input.target,
      ...input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection },
      ...(cron !== undefined ? { cron } : {}),
    })
    if (response === undefined || response.error !== undefined) return undefined
    await this.refresh()
    const created = (response.job as JobRecord | undefined) ?? this.jobs[this.jobs.length - 1]
    this.pendingCreateCron = undefined
    return created
  }

  /** Cron to arm on the next create (the modal stages it; the API takes it at create). */
  private pendingCreateCron: string | undefined

  /** Stage a cron for the next createJob call (NewJobModal's schedule field). */
  stageCreateCron(cron: string | undefined): void {
    this.pendingCreateCron = cron
  }

  async updateJob(id: string, patch: Partial<Pick<JobRecord, 'title' | 'description' | 'prompt'>> & { target?: SessionTarget; cron?: string; scheduleEnabled?: boolean; timeoutMinutes?: number }): Promise<void> {
    const body: Record<string, unknown> = { ...patch }
    if (patch.timeoutMinutes !== undefined) body.timeoutMinutes = patch.timeoutMinutes
    await this.fetchJson('PATCH', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, body)
    await this.refresh()
  }

  async deleteJob(id: string): Promise<void> {
    await this.fetchJson('DELETE', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`)
    if (this.selectedJobId === id) this.selectedJobId = undefined
    await this.refresh()
  }

  async resetJob(id: string): Promise<void> {
    await this.fetchJson('PATCH', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { resetStatus: true })
    await this.refresh()
  }

  async archiveJob(id: string): Promise<void> {
    await this.fetchJson('PATCH', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { archived: true })
    await this.refresh()
  }

  async restartJob(id: string): Promise<void> {
    await this.fetchJson('PATCH', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { restart: true })
    await this.refresh()
  }

  async setSchedule(id: string, patch: { enabled?: boolean; cron?: string }): Promise<boolean> {
    const body: Record<string, unknown> = {}
    if (patch.cron !== undefined) body.cron = patch.cron
    if (patch.enabled !== undefined) body.scheduleEnabled = patch.enabled
    const response = await this.fetchJson('PATCH', `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, body)
    await this.refresh()
    return response !== undefined && response.error === undefined
  }

  /** Host-owned now; kept for interface parity. */
  async applyScheduleNextRun(): Promise<void> {}

  /** Jump to an execution's session transcript. */
  openSession(sessionId: string): void {
    // The board overlays the conversation pane (single-occupant center
    // column): opening a session while the board stays active looks like
    // "nothing happened". Hand the column back FIRST, then navigate.
    this.closeJob()
    this.closeBoard()
    // A scheduled run's session is created headlessly and may not be in the
    // browser's list mirror yet — sessions.open() throws on unknown ids, so
    // refresh the list when the face offers it, and never let a navigation
    // failure escape into the click handler.
    const open = (): void => {
      try {
        this.sessions.open(sessionId)
      } catch (error) {
        console.warn('[dsh-timer-agent] open session failed:', sessionId, error)
      }
    }
    const refresh = this.sessions.refresh
    if (refresh === undefined) {
      open()
      return
    }
    // Call the face's refresh WITHOUT redelivery of `this`: the adapter's
    // closure is already bound to the concrete service, while the service's
    // own refresh is a prototype method whose `this` must be the service —
    // refresh.call(this.sessions) crashes with "Cannot read properties of
    // undefined (reading 'manager')" and the open() below never runs.
    try {
      void Promise.resolve(refresh()).then(open, open)
    } catch {
      open()
    }
  }

  /** Fire now (host runs it in the background). */
  async runJob(id: string): Promise<boolean> {
    const response = await this.fetchJson('POST', `/api/dsh-timer-agent/jobs/run?id=${encodeURIComponent(id)}`)
    await this.refresh()
    return response !== undefined && response.ok === true
  }

  /** Re-run a settled job (same as runJob — status guard is host-side). */
  async rerunJob(id: string): Promise<void> {
    await this.runJob(id)
  }

  // --- internals ---------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      const response = await this.fetchJson('GET', '/api/dsh-timer-agent/jobs')
      if (response !== undefined && Array.isArray(response.jobs)) {
        this.jobs = response.jobs as JobRecord[]
        this.notify()
      }
    } finally {
      this.refreshInFlight = false
    }
  }

  private async fetchJson(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetch(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      })
      if (response.status === 204) return {}
      return await response.json() as Record<string, unknown>
    } catch (error) {
      // Degrade to the stale mirror; the next poll retries.
      console.warn('[dsh-timer-agent] host route call failed:', method, url, error)
      return undefined
    }
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
