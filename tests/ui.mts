/**
 * UI-logic test suite for dsh-timer-agent (plain Node, no dsh runtime):
 *
 *   node --experimental-transform-types tests/ui.mts
 *
 * Covers the browser half's framework-free cores:
 *   1. board tab model: axis order, per-tab counts, tab filtering, guard
 *   2. locale completeness: every tab label key resolves in zh + en
 *   3. RemoteBoardController: polled mirror over a stubbed fetch, and the
 *      view-session jump fix (board + detail close before sessions.open,
 *      refresh-first for headless sessions, navigation failure contained)
 *
 * (.tsx components themselves are typechecked via `pnpm typecheck`; Node's
 * type-stripping does not execute JSX, so the interactive tree is covered
 * through its logic modules + controller.)
 */
import { RemoteBoardController } from '../src/client/remote-controller.ts'
import { BOARD_TABS, isBoardTab, jobsOfTab, tabCounts, TAB_LABEL_KEY } from '../src/client/board/tabs.ts'
import { detectSettlements } from '../src/client/settlements.ts'
import { zh, en, t } from '../src/client/locales.ts'
import type { SessionsControllerFace } from '../src/core/controller.ts'
import { createJob, withStatus, type ExecutionRecord, type JobRecord } from '../src/core/jobs.ts'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}
function section(name: string): void { console.log(`\n== ${name}`) }

// ============================================================================
// 1. tab model
// ============================================================================
section('tabs: axis + counts + filtering')
check('tab axis is 全部 first, 已归档 last, six tabs',
  BOARD_TABS.length === 6 && BOARD_TABS[0] === 'all' && BOARD_TABS[5] === 'archived',
  `${BOARD_TABS.join(',')}`)
check('every lifecycle status has a tab',
  (['idle', 'running', 'done', 'failed', 'archived'] as const).every(status => BOARD_TABS.includes(status)))
check('isBoardTab accepts real tabs', BOARD_TABS.every(tab => isBoardTab(tab)))
check('isBoardTab rejects junk', !isBoardTab('done ') && !isBoardTab('ALL') && !isBoardTab(42) && !isBoardTab(undefined))

function fixture(): JobRecord[] {
  const base = { title: 'j', description: '', prompt: 'p', target: { workdir: '', sessionId: '' } }
  const now = 1_000
  return [
    createJob({ ...base, title: 'a' }, now, 'id-a'),
    withStatus(createJob({ ...base, title: 'b' }, now, 'id-b'), 'running', now),
    withStatus(createJob({ ...base, title: 'c' }, now, 'id-c'), 'running', now),
    withStatus(createJob({ ...base, title: 'd' }, now, 'id-d'), 'done', now),
    withStatus(createJob({ ...base, title: 'e' }, now, 'id-e'), 'failed', now),
    withStatus(createJob({ ...base, title: 'f' }, now, 'id-f'), 'archived', now),
  ]
}

{
  const jobs = fixture()
  const counts = tabCounts(jobs)
  check('counts: all = total', counts.all === 6)
  check('counts: idle 1 / running 2 / done 1 / failed 1 / archived 1',
    counts.idle === 1 && counts.running === 2 && counts.done === 1 && counts.failed === 1 && counts.archived === 1,
    JSON.stringify(counts))
  check('counts over empty ledger are all zero with every key present',
    Object.values(tabCounts([])).every(value => value === 0) && Object.keys(tabCounts([])).length === BOARD_TABS.length)

  check('jobsOfTab all returns everything in order', jobsOfTab(jobs, 'all').length === 6 && jobsOfTab(jobs, 'all')[0].id === 'id-a')
  check('jobsOfTab running picks only running', jobsOfTab(jobs, 'running').map(job => job.id).join() === 'id-b,id-c')
  check('jobsOfTab idle picks the idle one', jobsOfTab(jobs, 'idle').map(job => job.id).join() === 'id-a')
  check('jobsOfTab on an empty status is empty', jobsOfTab(jobs.filter(job => job.status !== 'archived'), 'archived').length === 0)

  // Unknown statuses (forward compatibility) count only under 'all'.
  const future = [{ ...jobs[0], id: 'id-x', status: 'superseded' as never }] as JobRecord[]
  const futureCounts = tabCounts(future)
  check('unknown status lands only in all', futureCounts.all === 1 && futureCounts.idle === 0)
}

// ============================================================================
// 2. locale completeness for the tab surface
// ============================================================================
section('locales: tab labels resolve in zh + en')
check('TAB_LABEL_KEY covers every tab', BOARD_TABS.every(tab => typeof TAB_LABEL_KEY[tab] === 'string'))
check('every tab label key exists in zh', BOARD_TABS.every(tab => typeof zh[TAB_LABEL_KEY[tab]] === 'string'))
check('every tab label key exists in en', BOARD_TABS.every(tab => typeof en[TAB_LABEL_KEY[tab]] === 'string'))
check('zh tab labels render', t('board.tab.all') === '全部' && t('board.tab.failed') === '失败')
check('empty-tab copy exists in both dictionaries',
  typeof zh['board.emptyTab'] === 'string' && typeof en['board.emptyTab'] === 'string')

// ============================================================================
// 3. RemoteBoardController: mirror + the view-session jump fix
// ============================================================================
section('remote controller: mirror + openSession jump fix')

interface FetchCall { method: string; url: string }

function stubFetch(jobs: JobRecord[]): { calls: FetchCall[]; restore(): void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (((url: string | URL, init?: { method?: string }) => {
    const href = String(url)
    calls.push({ method: init?.method ?? 'GET', url: href })
    const respond = (status: number, body: unknown): Response => {
      const text = JSON.stringify(body)
      return { status, headers: new Map(), ok: status < 400,
        json: async () => JSON.parse(text) } as unknown as Response
    }
    if (href === '/api/dsh-timer-agent/jobs' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(respond(200, { jobs }))
    }
    return Promise.resolve(respond(204, {}))
  })) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 15)) }

function makeSessions(opts: { throwOnOpen?: boolean } = {}): SessionsControllerFace & { opened: string[]; refreshed: number } {
  const face = {
    opened: [] as string[],
    refreshed: 0,
    list: {
      getSnapshot: () => ({ current: undefined }),
      subscribe: () => () => {},
    },
    open: (id: string) => {
      if (opts.throwOnOpen === true) throw new Error(`sessions.select: unknown session ${id}`)
      face.opened.push(id)
    },
    refresh: async () => { face.refreshed += 1 },
  }
  return face as SessionsControllerFace & { opened: string[]; refreshed: number }
}

{
  const jobs = fixture()
  const stub = stubFetch(jobs)
  try {
    const sessions = makeSessions()
    const controller = new RemoteBoardController(sessions)
    controller.start()
    await flush()
    check('polled mirror loaded the ledger', controller.getSnapshot().jobs.length === 6)

    controller.openBoard()
    controller.openJob('id-b')
    check('board open + job selected', controller.getSnapshot().boardOpen === true && controller.getSnapshot().selectedJobId === 'id-b')

    // THE BUG FIX: the jump must hand the center column back to the
    // conversation — board closed, detail cleared — and navigate.
    controller.openSession('sess-1')
    await flush()
    const snapshot = controller.getSnapshot()
    check('openSession closes the board', snapshot.boardOpen === false)
    check('openSession clears the selected job', snapshot.selectedJobId === undefined)
    check('openSession refreshed the session list first (headless sessions)', sessions.refreshed >= 1)
    check('openSession navigated exactly once', sessions.opened.length === 1 && sessions.opened[0] === 'sess-1')

    // Re-opening the board keeps working afterwards.
    controller.openBoard()
    check('board re-opens after a jump', controller.getSnapshot().boardOpen === true)
    controller.dispose()
  } finally {
    stub.restore()
  }
}

{
  // sessions.open throwing (unknown id in the mirror) must stay contained.
  const stub = stubFetch(fixture())
  try {
    const sessions = makeSessions({ throwOnOpen: true })
    const controller = new RemoteBoardController(sessions)
    controller.start()
    await flush()
    controller.openBoard()
    let escaped = false
    try { controller.openSession('ghost') } catch { escaped = true }
    await flush()
    check('openSession never throws into the click handler', escaped === false)
    check('board still closed on navigation failure', controller.getSnapshot().boardOpen === false)
    controller.dispose()
  } finally {
    stub.restore()
  }
}

{
  // A sessions face without refresh() degrades to opening directly.
  const stub = stubFetch(fixture())
  try {
    const bare = {
      opened: [] as string[],
      list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
      open: (id: string) => { bare.opened.push(id) },
    }
    const controller = new RemoteBoardController(bare as unknown as SessionsControllerFace)
    controller.start()
    await flush()
    controller.openBoard()
    controller.openSession('sess-9')
    await flush()
    check('no-refresh face still navigates directly', bare.opened.length === 1 && bare.opened[0] === 'sess-9')
    check('board closed without refresh support', controller.getSnapshot().boardOpen === false)
    controller.dispose()
    // dispose cleared the poll timer: no further fetches.
    const before = stub.calls.length
    await new Promise(resolve => setTimeout(resolve, 30))
    check('dispose stops polling', stub.calls.length === before)
  } finally {
    stub.restore()
  }
}

// ============================================================================
// 4. settlement detection (pure diff)
// ============================================================================
section('settlements: detectSettlements pure diff')

function runningJob(id: string, title: string): JobRecord {
  const base = { title, description: '', prompt: 'p', target: { workdir: '', sessionId: '' } }
  const job = createJob(base, 1_000, id)
  const execution: ExecutionRecord = {
    id: `${id}-e1`, sessionId: `${id}-sess`, targeting: 'new-session',
    startedAt: 2_000, endedAt: undefined, result: undefined, error: undefined,
  }
  return { ...job, status: 'running', executions: [execution] }
}

function settled(job: JobRecord, result: 'succeeded' | 'failed' | 'cancelled', error?: string): JobRecord {
  return {
    ...job,
    status: result === 'succeeded' ? 'done' : result === 'failed' ? 'failed' : 'idle',
    executions: [{ ...job.executions[0], endedAt: 3_000, result, error }],
  }
}

{
  const prev = [runningJob('j1', 'daily standup')]
  check('running → succeeded emits done with session target',
    (() => {
      const events = detectSettlements(prev, [settled(prev[0], 'succeeded')])
      return events.length === 1 && events[0].result === 'done' && events[0].sessionId === 'j1-sess'
        && events[0].title === 'daily standup' && events[0].endedAt === 3_000
    })())
  check('running → failed emits failed with error',
    (() => {
      const events = detectSettlements(prev, [settled(prev[0], 'failed', 'boom')])
      return events.length === 1 && events[0].result === 'failed' && events[0].error === 'boom'
    })())
  check('cancelled settle is silent (deliberate stop)', detectSettlements(prev, [settled(prev[0], 'cancelled')]).length === 0)
  check('no transition → no event', detectSettlements(prev, prev).length === 0)
  check('still running → no event', detectSettlements(prev, [runningJob('j1', 'daily standup')]).length === 0)
  check('first poll (job unknown to prev) never replays history',
    detectSettlements([], [settled(prev[0], 'succeeded')]).length === 0)
  check('job removed → no event', detectSettlements(prev, []).length === 0)
  check('already-settled execution never re-notifies',
    detectSettlements([settled(prev[0], 'succeeded')], [settled(prev[0], 'succeeded')]).length === 0)
  check('locale keys exist in zh + en',
    typeof zh['notify.done.title'] === 'string' && typeof en['notify.done.title'] === 'string'
    && typeof zh['notify.failed.body'] === 'string' && typeof en['notify.failed.body'] === 'string')
  // A second execution settling later is news even though the first was
  // already settled in prev.
  {
    const firstSettled = settled(prev[0], 'succeeded')
    const second: ExecutionRecord = {
      id: 'j1-e2', sessionId: 'j1-sess2', targeting: 'new-session',
      startedAt: 4_000, endedAt: undefined, result: undefined, error: undefined,
    }
    const midRun: JobRecord = { ...firstSettled, status: 'running', executions: [...firstSettled.executions, second] }
    const done2: JobRecord = {
      ...midRun, status: 'done',
      executions: [...firstSettled.executions, { ...second, endedAt: 5_000, result: 'succeeded' }],
    }
    const events = detectSettlements([midRun], [done2])
    check('second execution settle emits exactly one event',
      events.length === 1 && events[0].sessionId === 'j1-sess2')
  }
}

// ============================================================================
// 5. controller announcements (stubbed Notification)
// ============================================================================
section('controller: settlement announcements over the poll mirror')

interface FakeNotification {
  title: string
  body: string
  tag: string
  onclick: (() => void) | undefined
}

function installNotifications(): { instances: FakeNotification[]; restore(): void } {
  const instances: FakeNotification[] = []
  const Ctor = class {
    onclick: (() => void) | undefined
    title: string
    body: string
    tag: string
    constructor(title: string, options: { body?: string, tag?: string }) {
      this.title = title
      this.body = options.body ?? ''
      this.tag = options.tag ?? ''
      instances.push(this as unknown as FakeNotification)
    }
    static permission: NotificationPermission = 'granted'
    static requestPermission: () => Promise<NotificationPermission> = async () => 'granted'
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const hadWindow = 'window' in globals
  const hadNotification = 'Notification' in globals
  const hadFocus = 'focus' in globals
  const previousWindow = globals.window
  const previousNotification = globals.Notification
  const previousFocus = globals.focus
  // The controller probes `'Notification' in window` (browser truth); make
  // globalThis itself the window so the probe sees the stubbed ctor.
  globals.window = globals
  globals.focus = () => {}
  globals.Notification = Ctor
  return {
    instances,
    restore: () => {
      if (hadWindow) globals.window = previousWindow
      else delete globals.window
      if (hadNotification) globals.Notification = previousNotification
      else delete globals.Notification
      if (hadFocus) globals.focus = previousFocus
      else delete globals.focus
    },
  }
}

{
  // Mutable ledger the fetch stub serves; flip it to simulate a settle.
  let ledger: JobRecord[] = [runningJob('n1', 'morning report')]
  const originalFetchImpl = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
    const href = String(url)
    if (href === '/api/dsh-timer-agent/jobs' && (init?.method ?? 'GET') === 'GET') {
      const text = JSON.stringify({ jobs: ledger })
      return { status: 200, json: async () => JSON.parse(text) } as unknown as Response
    }
    return { status: 204, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  const notifications = installNotifications()
  try {
    const sessions = makeSessions()
    const controller = new RemoteBoardController(sessions)
    controller.start()
    await flush()
    check('poll 1 (running) announces nothing', notifications.instances.length === 0)

    // The run settles while the board is closed.
    ledger = [settled(ledger[0], 'succeeded')]
    void controller.setSchedule('n1', { enabled: true }) // PATCH → refresh
    await flush()
    check('settle announces exactly one notification', notifications.instances.length === 1)
    const notice = notifications.instances[0]
    check('zh notification title + body carry the job title',
      notice.title === '定时任务完成' && notice.body.includes('morning report'), `${notice.title}/${notice.body}`)

    notice.onclick?.()
    await flush()
    check('notification click jumps to the run session', sessions.opened.length === 1 && sessions.opened[0] === 'n1-sess')
    check('notification click leaves the board closed', controller.getSnapshot().boardOpen === false)

    // No permission → silently no notification.
    notifications.instances.length = 0
    ;(globalThis as unknown as { Notification: { permission: NotificationPermission } }).Notification.permission = 'denied'
    ledger = [runningJob('n1', 'morning report')]
    void controller.setSchedule('n1', {})
    await flush()
    ledger = [settled(ledger[0], 'failed', 'boom')]
    void controller.setSchedule('n1', {})
    await flush()
    check('denied permission → no notification', notifications.instances.length === 0)

    // Permission back; a settle observed while the board is OPEN is silent
    // (the user is already looking at the tabs).
    ;(globalThis as unknown as { Notification: { permission: NotificationPermission } }).Notification.permission = 'granted'
    ledger = [runningJob('n1', 'morning report')]
    void controller.setSchedule('n1', {})
    await flush()
    controller.openBoard()
    ledger = [settled(ledger[0], 'succeeded')]
    await flush()
    check('board open → settle is not re-announced', notifications.instances.length === 0)
    controller.dispose()
  } finally {
    notifications.restore()
    globalThis.fetch = originalFetchImpl
  }
}

console.log(`\n== results: ${passed} passed, ${failed} failed (final)`)
if (failed > 0) process.exit(1)
