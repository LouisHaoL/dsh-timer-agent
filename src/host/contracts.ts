/**
 * Narrow local contracts for the DSH host services this plugin consumes
 * (dsh-lark-channel precedent): keeping these structural copies lets the
 * package build self-contained while a composed DSH profile supplies the
 * real implementations at runtime. Field shapes mirror `@deepseek-ai/dsh-agent`,
 * `@deepseek-ai/dsh-tools`, and the webserver's route surface as of
 * dsh 0.1.0-rc.6.
 * @module dsh-timer-agent/host-contracts
 */

/** The live session a host agent drives; identity + log read. */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
}

/** One model-facing text content block. */
export interface HostTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  readonly content: readonly HostTextBlock[]
  /** Producer tag: a scheduled run is still a direct human-style prompt. */
  readonly source: {
    readonly kind: 'user'
  }
}

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /** Clear queued work and abort the active turn. */
  cancel(cause: string): void
}

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /**
   * The live agent already running under an id, if any (no ownership
   * transfer; the host owns its lifetime). Mirrors the api-proxy resolver's
   * live-first lookup — `resume` refuses to prepare a session while it is
   * live, so pinned targets must reuse the live agent instead.
   */
  get?(sessionId: string): HostAgent | undefined
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    /** Per-agent overrides (provider, model, …); omit → keep the session's selection. */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }
    /** Pre-publication composition of the agent's scoped world (preset join). */
    readonly setup?: (agentCtx: object) => void | Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: {
      readonly cwd?: string
      readonly agentPreset?: string
    }
    /** Per-agent options (provider, model, …) — omitting model starves `{{model}}`. */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }
    /** Pre-publication composition of the agent's scoped world (preset join). */
    readonly setup?: (agentCtx: object) => void | Promise<void>
  }): Promise<HostAgentHandle>
}

/**
 * The `agentPresets` service (subset of the host `AgentPresets`): the preset
 * roster whose standing mounts give an agent its tools, prompt sections, and
 * skills. `mount` must run inside the agent factory's `setup` hook, where a
 * failure rolls the whole creation back.
 */
export interface HostAgentPresets {
  /** Resolve one preset by id (undefined = the deployment default). */
  resolve(id?: string): Promise<{ readonly id: string }>
  /** Join one agent's scope to a preset's standing composition. */
  mount(agentCtx: object, id?: string): Promise<unknown>
}

/**
 * The `sessionPersistence` service (subset): cold session inspection used to
 * rebuild a resumed session's recorded preset selection.
 */
export interface HostSessionPersistence {
  /** Read one session's header and event log without resuming it. */
  inspect(sessionId: string): Promise<{
    readonly meta: { readonly agentPreset?: string }
    readonly events: ReadonlyArray<{ readonly type: string, readonly data?: { readonly agentPreset?: string } }>
  }>
}

/**
 * The `agentDefaultModel` service (subset of the host
 * `AgentDefaultModelConfig`): the deployment-wide default model selection a
 * session-less entry point uses when the target carries no selection.
 */
export interface HostAgentDefaultModel {
  /** Detached provider/model (plus optional reasoning effort) selection. */
  currentSelection(): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
}

/** One provider row from the `llm` service's route registry. */
export interface HostLlmProvider {
  /** Provider route key. */
  readonly id: string
  /** Provider display name. */
  readonly name: string
}

/** One model a provider advertises (subset of `LlmModelInfo`). */
export interface HostLlmModel {
  /** Provider-owned model id. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
}

/**
 * The `llm` service (subset of the host LLM registry): the provider/model
 * catalog for selection surfaces.
 */
export interface HostLlm {
  /** Every registered provider route. */
  listProviders(): readonly HostLlmProvider[]
  /** One provider's advertised models (throws per-provider on failure). */
  listModels(provider: string): Promise<readonly HostLlmModel[]>
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /** Account one session under this workspace (validates header cwd). */
  attachSession(id: string): Promise<unknown>
}

/** The `workspaceRegistry` service (subset of the host registry). */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
  /** Every registered workspace (optional on older registries). */
  list?(): readonly HostWorkspace[]
}

/** One immutable entry in the host session log. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The `turn/end` payload fields the runner settles on. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: {
      readonly code?: string
      readonly message?: string
    }
  }
}

/** Narrow a session event to a closed turn boundary. */
export function isTurnEndEvent(event: HostSessionEvent): event is HostSessionEvent & { readonly data: TurnEndData } {
  if (event.type !== 'turn/end') return false
  const data = event.data as TurnEndData | undefined
  return typeof data === 'object' && data !== null && typeof data.reason?.kind === 'string'
}

/** Render a failed turn's reason as one operator-readable line. */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  if (error === undefined) return 'turn failed'
  return error.message ?? error.code ?? 'turn failed'
}

/** One webserver route registration (the dsh-ssh route surface). */
export interface HostRoute {
  /** 'exact' matches the full path; 'prefix' matches a path prefix. */
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  handler(req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> | void
}

/** The `webServer` service (subset of the host webserver). */
export interface HostWebServer {
  register(route: HostRoute): () => void
}

// Node http types spelled structurally so the package needs no @types/node
// at the type level beyond these interfaces.
export interface NodeIncomingMessage {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly socket: { readonly remoteAddress?: string }
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>
}

export interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(chunk?: string | Uint8Array): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
    /** The host webserver route surface; required via `inject`. */
    webServer: HostWebServer
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
  }
}

/**
 * Structural face the host apply() uses (keeps the entry thin). Not a Context
 * extension — cordis generics over event keys make a narrowed `on` incompatible;
 * the real context satisfies this shape structurally.
 */
export interface HostPluginContext {
  agents: HostAgentRegistry
  webServer: HostWebServer
  /** The host default-model service, when mounted ('agentDefaultModel'). */
  get(service: 'agentDefaultModel'): HostAgentDefaultModel | undefined
  /** The host LLM registry, when mounted ('llm'). */
  get(service: 'llm'): HostLlm | undefined
  /** The preset roster, when mounted ('agentPresets'). */
  get(service: 'agentPresets'): HostAgentPresets | undefined
  /** The session persistence service, when mounted ('sessionPersistence'). */
  get(service: 'sessionPersistence'): HostSessionPersistence | undefined
  get(service: string): unknown
  on(event: 'session/event', listener: (session: HostSession, event: HostSessionEvent) => void): () => void
  effect(setup: () => () => void, label?: string): void
  tools?: { register(def: unknown): () => void }
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
  }
}
