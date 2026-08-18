/**
 * Timer-agent client plugin (host-authoritative edition): mounts the two
 * DOM surfaces over the REMOTE controller — the sidebar entry row and the
 * board view in the center column. All state lives in the host engine
 * (~/.dsh/timer-agent/jobs.json); this half is a polled mirror + HTTP
 * command sender. The scheduler/execution core the browser used to own is
 * retired: the dsh web host process ticks and fires jobs with or without
 * this page open.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import { RemoteBoardController } from './remote-controller.ts'
import { mountBoard } from './board-mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { listTargetOptions } from './target-options.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'sessions']

/**
 * Mount the timer-agent board.
 * @param ctx - client root context (services: sessions).
 */
export function apply(ctx: unknown): void {
  const sessions = ctx as {
    list: { getSnapshot(): { current: string | undefined }; subscribe(fn: () => void): () => void }
    open(id: string): void
  }

  // Adapt the sessions service to SessionsControllerFace.
  // The sessions.list is an ObservableSnapshot with getSnapshot/subscribe,
  // and sessions.open opens a session by id.
  const sessionsFace: import('../core/controller.js').SessionsControllerFace = {
    list: {
      getSnapshot: () => {
        const snapshot = sessions.list.getSnapshot()
        return { current: snapshot.current }
      },
      subscribe: (fn: () => void) => {
        return sessions.list.subscribe(fn)
      },
    },
    open: (id: string) => {
      sessions.open(id)
    },
  }

  const controller = new RemoteBoardController(sessionsFace)
  controller.start()

  const disposers: Array<() => void> = []
  try {
    // Session-target dropdown data source: rebuilt on each modal open.
    const targetOptions = (): ReturnType<typeof listTargetOptions> => listTargetOptions(ctx as never)
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountBoard(controller, targetOptions))
  } catch (error) {
    // DOM failures degrade the board, never the GUI.
    console.error('[dsh-timer-agent] mount failed:', error)
  }

  ;(ctx as { effect(setup: () => () => void, key: string): unknown }).effect(() => {
    // Cordis effect semantics: setup runs now and its RETURN VALUE is the
    // registered teardown. Returning the disposer (not running it here) is
    // the fix for the entry-vanishing bug: as a direct body it executed at
    // apply time and tore the mounts down immediately after mounting them.
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      controller.dispose()
    }
  }, 'dsh-timer-agent: unmount')
}
