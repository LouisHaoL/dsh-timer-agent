/**
 * Board tab model: the status-tab axis the board lists jobs along, plus the
 * pure counting/filtering helpers. Kept framework-free (no React, no CSS
 * import) so the tab semantics are unit-testable in plain Node.
 *
 * Tabs: 全部 / 待机 / 进行中 / 成功 / 失败 / 已归档 — one per lifecycle
 * status (failed included so failed jobs are never stranded) plus the
 * aggregate "all" tab. Counts always reflect the WHOLE ledger, not the
 * search-filtered subset (the search box narrows within the active tab).
 * Archived jobs are deliberately excluded from "全部" (both list and
 * count): they remain reachable only through the 已归档 tab.
 */
import type { JobRecord, JobStatus } from '../../core/jobs.ts'
import type { TimerAgentKey } from '../locales.ts'

/** The board's tab axis; 'all' aggregates every status. */
export type BoardTab = 'all' | JobStatus

/** Tab order as rendered (全部 first, 已归档 last). */
export const BOARD_TABS: readonly BoardTab[] = ['all', 'idle', 'running', 'done', 'failed', 'archived']

/** Tab → label locale key ('all' + one per status). */
export const TAB_LABEL_KEY: Record<BoardTab, TimerAgentKey> = {
  all: 'board.tab.all',
  idle: 'board.tab.idle',
  running: 'board.tab.running',
  done: 'board.tab.done',
  failed: 'board.tab.failed',
  archived: 'board.tab.archived',
}

/** Guard a unknown value as a tab key. */
export function isBoardTab(value: unknown): value is BoardTab {
  return typeof value === 'string' && (BOARD_TABS as readonly string[]).includes(value)
}

/** Per-tab job counts keyed by tab (every tab always present). */
export type TabCounts = Readonly<Record<BoardTab, number>>

/**
 * Count jobs per tab over the whole ledger. "全部" excludes archived
 * jobs (they have their own tab); unknown statuses (forward
 * compatibility) land only in 'all'.
 */
export function tabCounts(jobs: readonly JobRecord[]): TabCounts {
  const counts: Record<string, number> = {}
  for (const tab of BOARD_TABS) counts[tab] = 0
  counts.all = jobs.filter(job => job.status !== 'archived').length
  for (const job of jobs) {
    if (job.status in counts) counts[job.status] += 1
  }
  return counts as TabCounts
}

/** The jobs one tab shows, in ledger order; "全部" hides archived. */
export function jobsOfTab(jobs: readonly JobRecord[], tab: BoardTab): readonly JobRecord[] {
  if (tab === 'all') return jobs.filter(job => job.status !== 'archived')
  return jobs.filter(job => job.status === tab)
}
