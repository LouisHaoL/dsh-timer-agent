/**
 * Sessions-service adapter: narrows the client runtime's injected sessions
 * service to the SessionsControllerFace the board consumes.
 *
 * Cordis boundary rule this module exists to enforce: the ctx object is a
 * proxy where ONLY names declared in `inject` resolve — any other property
 * read throws `cannot get property "<name>" without inject` and an eager
 * read at apply time fails the whole web boot ("failed to apply loader
 * entry"). Callers must therefore resolve `ctx.sessions` (declared) once and
 * hand the plain service object here; nothing in this file ever touches the
 * proxy itself.
 */
import type { SessionsControllerFace } from '../core/controller.ts'

/** The sessions-service members this adapter consumes (ISessions subset). */
export interface SessionsServiceShape {
  /** ObservableSnapshot of the list rows + current selection. */
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
  /** Select a session as current (navigates the conversation view). */
  open(id: string): void
  /**
   * Re-pull the list from the host. A wire-pump entry point the public
   * ISessions face deliberately omits — present on the concrete service,
   * so feature-detect and degrade to open-only when absent.
   */
  refresh?(): Promise<void>
}

/**
 * Adapt the resolved sessions service to SessionsControllerFace.
 * @param service - the plain service object behind `ctx.sessions`.
 * @returns the navigation face for RemoteBoardController.
 */
export function sessionsFaceOf(service: SessionsServiceShape): SessionsControllerFace {
  // Capture the optional member once so the typeof guard narrows it for the
  // forwarded closure below (const narrowing survives into closures).
  const serviceRefresh = service.refresh
  return {
    list: {
      getSnapshot: () => {
        const snapshot = service.list.getSnapshot()
        return { current: snapshot.current }
      },
      subscribe: (fn: () => void) => {
        return service.list.subscribe(fn)
      },
    },
    open: (id: string) => {
      service.open(id)
    },
    // Forward the list re-pull when the service offers it (headlessly
    // created run sessions are invisible to a stale mirror; see
    // remote-controller.openSession).
    ...(typeof serviceRefresh === 'function'
      ? { refresh: () => serviceRefresh() }
      : {}),
  }
}
