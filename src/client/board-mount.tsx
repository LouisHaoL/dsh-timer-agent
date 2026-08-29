/**
 * Board view mounting (task-board precedent): the `conversation` slot is
 * single-occupant, so the board takes over the center column at the DOM
 * level — a container appended inside the `[data-pane="conversation"]` grid
 * item, hidden unless this panel is active. Toggling is a data attribute on
 * <html>; sibling panels (task board / ssh) evict each other through the
 * shared `dsh-panel-activate` event.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { TargetGroup } from './target-options.ts'
import { listModelOptions, listPresetOptions, type ModelOptions, type PresetOptions } from './target-options.ts'
import type { BoardControllerFace } from './controller-face.ts'
import { TimerBoard } from './board/TimerBoard.tsx'
import css from './board.module.css'

/** The injected board container (kept in the DOM, hidden when inactive). */
export const BOARD_VIEW_SELECTOR = '[data-dsh-timeragent-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"]'
const ACTIVE_ATTR = 'data-dsh-timeragent-active'
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'timeragent'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  // Try multiple selectors for different DSH versions/shells
  const selectors = [
    '[data-pane="conversation"]',
    '[class*="centerCol"]',
    '[class*="conversation"]:not([class*="sidebar"])',
  ]
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el) return el
  }
  return undefined
}

/**
 * Mount the board React tree into the center column and bind its visibility
 * to the controller's boardOpen state.
 * @param controller - the board controller driving the view.
 * @param targetOptions - session-target dropdown data source (rebuilt on
 *   each modal open; see target-options.ts).
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountBoard(controller: BoardControllerFace, targetOptions: () => Promise<TargetGroup[]>): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const modelOptions = (): Promise<ModelOptions> => listModelOptions()
  const presetOptions = (): Promise<PresetOptions> => listPresetOptions()

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshTimeragentView = ''
    container.className = css.boardView
    column.appendChild(container)
    root = createRoot(container)
    root.render(<TimerBoard controller={controller} targetOptions={targetOptions} modelOptions={modelOptions} presetOptions={presetOptions} />)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().boardOpen) {
      // Single-occupant center column: opening this panel evicts sibling
      // panels (their html attributes and controller state).
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== PANEL_NAME && controller.getSnapshot().boardOpen) {
      controller.closeBoard()
    }
  }
  // Jump out on sidebar context clicks (session/workspace rows hand the
  // center column back to the conversation). Capture phase.
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().boardOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
