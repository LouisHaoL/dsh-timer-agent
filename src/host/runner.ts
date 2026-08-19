/**
 * Host runner: the hermes-cron-shaped engine.
 *
 * - `tick()` (60s interval, the dsh web host process's lifetime): due jobs
 *   fire, schedule rolled forward BEFORE execution (at-most-once), skipped
 *   when the job is already running.
 * - Execution: pinned sessionId → `agents.resume` (context continuity);
 *   otherwise `agents.create` in the target workdir (default workspace when
 *   blank) — a fresh session per run, attached to the workspace record so
 *   the GUI groups it under the right project.
 * - Settlement: the queued user message id is correlated through
 *   `session/event` (`user/message` consumes it, `turn/end` settles the
 *   execution success/failed).
 */
import { randomUUID } from 'node:crypto'
import type {
  HostAgent, HostAgentHandle, HostAgentRegistry, HostPluginContext,
  HostSession, HostSessionEvent, HostUserMessage, HostWorkspaceRegistry,
} from './contracts.ts'
import { isTurnEndEvent, turnErrorDetail } from './contracts.ts'
import type { HostJobStore } from './store.ts'
import { nextRunAtMs } from '../core/schedule.ts'
import {
  settleExecution, startExecution, withSchedule,
  type ExecutionRecord, type JobRecord,
} from '../core/jobs.ts'

/** Everything the runner needs from the host composition. */
export interface RunnerDeps {
  ctx: HostPluginContext
  store: HostJobStore
  /** Clock; injectable for tests. */
  now?: () => number
}

/** Slug a job title into a session-id-safe prefix (hermes names its cron sessions the same way). */
function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return base === '' ? 'job' : base.slice(0, 32)
}

/** Safely read a selection off the default-model service (undefined on throw). */
function trySelection(defaults: { currentSelection(): { provider: string, model: string } }): { provider: string, model: string } | undefined {
  try {
    const selection = defaults.currentSelection()
    if (selection.provider === '' || selection.model === '') return undefined
    return selection
  } catch {
    return undefined
  }
}

/**
 * The live agent for a pinned id, wrapped as a non-owning handle (dispose is
 * a no-op — the host, e.g. the open GUI session, owns its lifetime). Returns
 * undefined when no live agent is registered under the id.
 */
function liveAgentHandle(agents: HostAgentRegistry, sessionId: string): HostAgentHandle | undefined {
  const live = agents.get?.(sessionId)
  if (live === undefined) return undefined
  return { agent: live, dispose: async () => undefined }
}

/** One in-flight execution the session-event watcher tracks. */
interface InFlight {
  jobId: string
  executionId: string
  sessionId: string
  messageId: string
  /** Whether the session log consumed our message yet. */
  consumed: boolean
}

/**
 * The scheduled-jobs engine. One instance per host plugin apply(); owns the
 * ticker interval, the in-flight map, and the session-event subscription.
 */
export class TimerRunner {
  private readonly ctx: HostPluginContext
  private readonly store: HostJobStore
  private readonly now: () => number
  private readonly inFlight = new Map<string, InFlight>() // by messageId
  private timer: ReturnType<typeof setInterval> | undefined
  private requestTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** Agent handles for pinned sessions, kept alive across runs (lark precedent). */
  private readonly pinnedHandles = new Map<string, HostAgentHandle>()

  constructor(deps: RunnerDeps) {
    this.ctx = deps.ctx
    this.store = deps.store
    this.now = deps.now ?? (() => Date.now())
  }

  /** Start the ticker + the session-event watcher. */
  start(): void {
    if (this.disposed) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, 60_000)
    // Manual-run requests (tool / web UI) deserve a snappier response than
    // the schedule tick: a cheap 5s poll that only reads the request field.
    this.requestTimer = setInterval(() => { void this.pollRequests() }, 5_000)
    this.ctx.effect(() => () => { this.stop() }, 'dsh-timer-agent: runner')
    this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
  }

  /** Stop the ticker (idempotent; pinned handles disposed with the plugin). */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.requestTimer !== undefined) clearInterval(this.requestTimer)
    this.timer = undefined
    this.requestTimer = undefined
  }

  /** Fire pending manual-run requests only (the 5s fast path). */
  private async pollRequests(): Promise<void> {
    if (this.disposed) return
    const jobs = await this.store.load()
    if (!jobs.some(job => job.runRequestedAt !== undefined)) return
    await this.tick()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stop()
    for (const handle of this.pinnedHandles.values()) {
      await handle.dispose().catch(() => undefined)
    }
    this.pinnedHandles.clear()
  }

  /**
   * One scheduler pass: fire due schedules, then manual run requests.
   * (at-most-once: `nextRunAt` rolls forward before the run is accepted.)
   */
  async tick(): Promise<number> {
    if (this.disposed) return 0
    const jobs = await this.store.load()
    let fired = 0
    for (const job of jobs) {
      // 1. due schedule (archived jobs never fire)
      const schedule = job.schedule
      if (job.status !== 'archived'
        && schedule !== undefined && schedule.enabled && schedule.nextRunAt !== undefined && schedule.nextRunAt <= this.now()) {
        const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
        if (await this.requestRun(job.id)) {
          fired += 1
          await this.store.mutate(current => {
            const row = current.find(candidate => candidate.id === job.id)
            if (row === undefined || row.schedule === undefined) return undefined
            return {
              jobs: current.map(candidate =>
                candidate.id === job.id
                  ? withSchedule(candidate, { nextRunAt: next, lastTriggeredAt: this.now() }, this.now())
                  : candidate),
              result: true,
            }
          })
        }
      }
      // 2. manual run request (from the tool or the web UI)
      if (job.runRequestedAt !== undefined) {
        await this.store.mutate(current => {
          const row = current.find(candidate => candidate.id === job.id)
          if (row === undefined || row.runRequestedAt === undefined) return undefined
          return {
            jobs: current.map(candidate =>
              candidate.id === job.id ? { ...candidate, runRequestedAt: undefined } : candidate),
            result: true,
          }
        })
        if (await this.requestRun(job.id)) fired += 1
      }
    }
    return fired
  }

  /**
   * Fire one job now (used by the tool's action='run' and the web UI's Run
   * button). Rejects while the job is already running (skip-while-running).
   */
  async requestRun(jobId: string, extraPrompt?: string): Promise<boolean> {
    if (this.disposed) return false
    const outcome = await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined || job.status === 'running' || job.status === 'archived') return undefined
      const targeting = job.target.sessionId !== '' ? 'specified-session' : 'new-session'
      const { job: next, execution } = startExecution(job, this.now(), randomUUID(), targeting)
      if (extraPrompt !== undefined && extraPrompt.trim() !== '') {
        execution.error = undefined
        next.prompt = `${next.prompt}\n\n## Run Context\n${extraPrompt}`.trim()
      }
      return {
        jobs: current.map(candidate => (candidate.id === jobId ? next : candidate)),
        result: { job: next, execution },
      }
    })
    if (outcome === undefined) return false
    void this.execute(outcome.job, outcome.execution)
    return true
  }

  /** The real execution: connect/create the agent, send the prompt. */
  private async execute(job: JobRecord, execution: ExecutionRecord): Promise<void> {
    try {
      const handle = await this.connectAgent(job)
      const agent: HostAgent = handle.agent
      await this.recordSessionId(job.id, execution.id, agent.session.id)
      const message: HostUserMessage = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: job.prompt.trim() !== '' ? job.prompt : job.title }],
        source: { kind: 'user' },
      }
      this.inFlight.set(message.id, {
        jobId: job.id,
        executionId: execution.id,
        sessionId: agent.session.id,
        messageId: message.id,
        consumed: false,
      })
      agent.followup(message)
    } catch (error) {
      await this.settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Pinned session → live agent if one is running, else resume (cached);
   * otherwise a new session in the workdir.
   */
  private async connectAgent(job: JobRecord): Promise<HostAgentHandle> {
    const pinnedId = job.target.sessionId
    if (pinnedId !== '') {
      // Live-first (api-proxy resolver precedent): persistence refuses to
      // prepare a session that is already live, so reuse the running agent
      // (e.g. the GUI session the user pinned is open right now).
      const agents: HostAgentRegistry = this.ctx.agents
      const live = liveAgentHandle(agents, pinnedId)
      if (live !== undefined) return live
      const cached = this.pinnedHandles.get(pinnedId)
      if (cached !== undefined) return cached
      // Rebuild the session's recorded preset composition for the resume
      // (api-proxy agentFor precedent): a cold resume without the join runs
      // the session on host-plane tools instead of the composition its
      // history was produced under. Failure to compose degrades to a bare
      // resume rather than abandoning the pinned conversation.
      let resumeSetup: ((agentCtx: object) => Promise<void>) | undefined
      try {
        resumeSetup = await this.presetSetupFor(pinnedId)
      } catch (error) {
        console.warn('[dsh-timer-agent] preset composition for pinned session failed; resuming bare:', error)
      }
      try {
        // An explicit per-job model selection overrides the session's own;
        // without one the resume keeps the session's persisted selection.
        const handle = await agents.resume({
          resumeSessionId: pinnedId,
          ...job.modelSelection === undefined ? {} : { agentOptions: { ...job.modelSelection } },
          ...resumeSetup === undefined ? {} : { setup: resumeSetup },
        })
        this.pinnedHandles.set(pinnedId, handle)
        return handle
      } catch (error) {
        // Resume can lose the race against the session going live; re-check
        // before giving up so we never fork a live pinned session.
        const raced = liveAgentHandle(agents, pinnedId)
        if (raced !== undefined) return raced
        // The pinned session may have been deleted; fall through to a new
        // session rather than failing the job forever.
        console.warn('[dsh-timer-agent] resume of pinned session failed; creating a new one:', error)
      }
    }
    const agents: HostAgentRegistry = this.ctx.agents
    const sessionId = `timer-${slug(job.title)}-${new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
    // A fresh session has no persisted model selection, and the deployment
    // persona template references `{{model}}` strictly: creating without
    // agentOptions starves that variable and the first turn fails before any
    // work starts. Resolution order: the job's own model selection, else the
    // deployment agentDefaultModel (mirroring the GUI/headless entry points).
    const defaults = this.ctx.get('agentDefaultModel')
    let agentOptions: { provider?: string, model?: string, reasoningEffort?: string } | undefined
    const seed = job.modelSelection ?? (defaults === undefined ? undefined : trySelection(defaults))
    if (seed !== undefined) {
      agentOptions = { provider: seed.provider, model: seed.model }
    }
    // Join the deployment's default agent preset: without it the new session
    // runs on the empty global layer — no tool packages, no preset prompt
    // sections. A broken default preset fails the run loudly (creation rolls
    // back with the resolver's error), matching the GUI's behavior.
    let presetMeta: { agentPreset: string } | undefined
    let presetSetup: ((agentCtx: object) => Promise<void>) | undefined
    ;({ presetMeta, presetSetup } = await this.composeDefaultPreset())
    const handle = await agents.create({
      sessionId,
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      ...(job.target.workdir !== ''
        ? { meta: { cwd: job.target.workdir, ...presetMeta } }
        : presetMeta === undefined ? {} : { meta: presetMeta }),
      ...(presetSetup === undefined ? {} : { setup: presetSetup }),
    })
    await this.attachWorkspace(sessionId, job.target.workdir).catch(() => undefined)
    return handle
  }

  /**
   * Compose a NEW session's default preset: resolve the roster default, record
   * it on the session header, and join the agent's scope to its standing
   * mount inside the factory setup hook (api-proxy composeAgent precedent —
   * the join decides the agent's tools, prompt sections, and skills, so a
   * session created bare resolves them against the empty global layer).
   * Undefined parts when no roster is composed; a broken default preset
   * rejects so creation rolls back with the resolver's error.
   */
  private async composeDefaultPreset(): Promise<{
    presetMeta: { agentPreset: string } | undefined
    presetSetup: ((agentCtx: object) => Promise<void>) | undefined
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { presetMeta: undefined, presetSetup: undefined }
    const resolvedId = (await presets.resolve()).id
    return {
      presetMeta: { agentPreset: resolvedId },
      presetSetup: async agentCtx => { await presets.mount(agentCtx, resolvedId) },
    }
  }

  /**
   * Compose a RESUMED session's recorded preset: the last
   * `agent-preset/selected` event wins over the creation header
   * (`resolveSessionPreset` semantics), read through cold persistence
   * inspection; a session that recorded none falls back to the roster
   * default. Rejection means "compose nothing" — the caller resumes bare
   * rather than abandoning the pinned conversation.
   */
  private async presetSetupFor(sessionId: string): Promise<((agentCtx: object) => Promise<void>) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    let recorded: string | undefined
    try {
      const persistence = this.ctx.get('sessionPersistence')
      const inspected = persistence === undefined ? undefined : await persistence.inspect(sessionId)
      if (inspected !== undefined) {
        for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
          const event = inspected.events[index]
          if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            recorded = event.data.agentPreset
            break
          }
        }
        recorded = recorded ?? inspected.meta.agentPreset
      }
    } catch {
      recorded = undefined
    }
    const resolvedId = (await presets.resolve(recorded)).id
    return async agentCtx => { await presets.mount(agentCtx, resolvedId) }
  }

  /** Best-effort workspace grouping so the run lands under the right project in the GUI. */
  private async attachWorkspace(sessionId: string, workdir: string): Promise<void> {
    if (workdir === '') return
    const registry = this.ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
    if (registry === undefined) return
    const workspace = await registry.resolveByPath(workdir) ?? await registry.create(workdir).catch(() => undefined)
    await workspace?.attachSession(sessionId)
  }

  /** Fold the session-event stream into execution settlement. */
  private onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    for (const flight of this.inFlight.values()) {
      if (flight.sessionId !== session.id) continue
      if (event.type === 'user/message') {
        const id = (event.data as { id?: string } | null)?.id
        if (id === flight.messageId) flight.consumed = true
        continue
      }
      if (isTurnEndEvent(event) && flight.consumed) {
        const detail = turnErrorDetail(event.data)
        void this.settle(flight.jobId, flight.executionId, detail === '' ? 'succeeded' : 'failed', detail === '' ? undefined : detail)
        this.inFlight.delete(flight.messageId)
      }
    }
  }

  /** Persist a settled (or failed-to-start) execution and job status. */
  private async settle(jobId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<void> {
    await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined) return undefined
      return {
        jobs: current.map(candidate =>
          candidate.id === jobId ? settleExecution(candidate, executionId, outcome, this.now(), error) : candidate),
        result: true,
      }
    })
  }

  /** Record which session an execution landed in (the 'started' event). */
  private async recordSessionId(jobId: string, executionId: string, sessionId: string): Promise<void> {
    await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined) return undefined
      return {
        jobs: current.map(candidate => candidate.id === jobId
          ? {
              ...candidate,
              updatedAt: this.now(),
              executions: candidate.executions.map(execution =>
                execution.id === executionId ? { ...execution, sessionId } : execution),
            }
          : candidate),
        result: true,
      }
    })
  }
}
