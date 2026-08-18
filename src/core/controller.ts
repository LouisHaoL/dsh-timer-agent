/**
 * Shared controller types: the immutable snapshot the UI subscribes to and
 * the sessions navigation face. (The browser-side execution controller was
 * retired with the host-authoritative engine; the remote controller in
 * client/remote-controller.ts implements this surface over the host routes.)
 */

/** The sessions face the UI needs for navigation awareness. */
export interface SessionsControllerFace {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
  /** Select a session as current (navigates the conversation view). */
  open(id: string): void
}

/** Immutable controller snapshot for UI subscriptions. */
export interface ControllerSnapshot {
  jobs: readonly import('./jobs.ts').JobRecord[]
  boardOpen: boolean
  selectedJobId: string | undefined
}

/** The selected job (resolved from the ledger), or undefined. */
export function selectedJobOf(snapshot: ControllerSnapshot): import('./jobs.ts').JobRecord | undefined {
  if (snapshot.selectedJobId === undefined) return undefined
  return snapshot.jobs.find(job => job.id === snapshot.selectedJobId)
}
