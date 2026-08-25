/**
 * Cordis-boundary regression suite for the client apply wiring:
 *
 *   node --experimental-transform-types tests/client-apply.mts
 *
 * Guards the boot crash class of 2026-08-25 ("failed to apply loader entry
 * ... cannot get property 'refresh' without inject"): the ctx object the
 * loader hands a client plugin is a Cordis proxy where ONLY names declared
 * in `inject` resolve; every other property read throws, and an eager read
 * at apply time took the whole web GUI down. These checks run the sessions
 * adapter through a REAL @deepseek-ai/cordis app so the proxy semantics are
 * the shipped ones, not a mock's guess.
 *
 * (index.ts itself cannot run under Node's type-stripping — it imports the
 * JSX board mounts — so its sessions wiring lives in sessions-face.ts and
 * is exercised here; ui.mts covers the controller that consumes the face.)
 */
import { Context } from '@deepseek-ai/cordis'
import { sessionsFaceOf, type SessionsServiceShape } from '../src/client/sessions-face.ts'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}
function section(name: string): void { console.log(`\n== ${name}`) }

/** A sessions service double shaped like the runtime's concrete class:
 *  the public ISessions members plus the wire-pump refresh() it omits. */
function makeService(opts: { withRefresh?: boolean } = {}): SessionsServiceShape & {
  opened: string[]
  refreshes: number
  subscribers: Array<() => void>
} {
  const state = { current: 'sess-current' }
  const svc = {
    opened: [] as string[],
    refreshes: 0,
    subscribers: [] as Array<() => void>,
    list: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        svc.subscribers.push(fn)
        return () => { svc.subscribers = svc.subscribers.filter(f => f !== fn) }
      },
    },
    open(id: string) { svc.opened.push(id); state.current = id },
    ...(opts.withRefresh === false ? {} : {
      refresh: async () => { svc.refreshes += 1 },
    }),
  }
  return svc as typeof svc & SessionsServiceShape
}

/** Provide slots+sessions on a fresh app, mirroring the client runtime. */
function makeApp(sessions: SessionsServiceShape): Context {
  const app = new Context()
  app.provide('slots', {})
  app.provide('sessions', sessions)
  return app
}

// ============================================================================
// 1. the fixed wiring applies cleanly against the real proxy
// ============================================================================
section('apply wiring over a real cordis app')
{
  const svc = makeService()
  const app = makeApp(svc)
  let face: ReturnType<typeof sessionsFaceOf> | undefined

  const plugin = {
    inject: ['slots', 'sessions'],
    apply(ctx: { sessions: SessionsServiceShape }) {
      // Exactly the index.ts wiring: resolve the declared service, adapt.
      face = sessionsFaceOf(ctx.sessions)
    },
  }
  let applyError: unknown
  await app.plugin(plugin).then(() => {}, (error: unknown) => { applyError = error })
  check('plugin apply completes (no inject crash)', applyError === undefined, String(applyError))
  check('face was built', face !== undefined)

  if (face !== undefined) {
    check('list.getSnapshot projects current', face.list.getSnapshot().current === 'sess-current')
    let notified = 0
    const unsubscribe = face.list.subscribe(() => { notified += 1 })
    svc.subscribers[0]?.()
    check('list.subscribe forwards to the service', notified === 1)
    unsubscribe()
    svc.subscribers[0]?.()
    check('unsubscribed listener is detached', notified === 1)

    face.open('sess-9')
    check('open routes to the service', svc.opened.length === 1 && svc.opened[0] === 'sess-9')
    check('snapshot follows the opened session', face.list.getSnapshot().current === 'sess-9')

    check('refresh is forwarded when the service offers it', typeof face.refresh === 'function')
    await face.refresh?.()
    check('refresh() calls through to the service', svc.refreshes === 1)
  }
}

// ============================================================================
// 2. degrade when the concrete service has no refresh
// ============================================================================
section('face without service refresh degrades to open-only')
{
  const svc = makeService({ withRefresh: false })
  const face = sessionsFaceOf(svc)
  check('no refresh key on the face', face.refresh === undefined)
  face.open('sess-1')
  check('open still works', svc.opened.length === 1)
}

// ============================================================================
// 3. guard rail: the ctx proxy semantics that caused the boot crash
// ============================================================================
section('ctx proxy: only inject names resolve (the old bug)')
{
  const svc = makeService()
  const app = makeApp(svc)

  // ctx.sessions resolves because 'sessions' is declared in inject.
  let resolved: unknown
  const resolvePlugin = {
    inject: ['slots', 'sessions'],
    apply(ctx: Record<string, unknown>) { resolved = ctx.sessions },
  }
  let resolveError: unknown
  await app.plugin(resolvePlugin).then(() => {}, (error: unknown) => { resolveError = error })
  check('ctx.sessions resolves through the proxy', resolveError === undefined && resolved === svc)

  // Reading service members straight off the proxy is the crash: an eager
  // `typeof ctx.refresh === 'function'` at apply time failed the web boot.
  const readCtxProp = async (prop: string): Promise<string> => {
    const probe = {
      inject: ['slots', 'sessions'],
      apply(ctx: Record<string, unknown>) { void (ctx as Record<string, unknown>)[prop] },
    }
    let error: unknown
    await app.plugin(probe).then(() => {}, (e: unknown) => { error = e })
    return error instanceof Error ? error.message : `no throw (${String(error)})`
  }
  check('ctx.refresh read throws the boot-crash error',
    (await readCtxProp('refresh')).includes('cannot get property "refresh" without inject'),
    await readCtxProp('refresh'))
  check('ctx.list read would throw the same way',
    (await readCtxProp('list')).includes('cannot get property "list" without inject'))
  check('ctx.open read would throw the same way',
    (await readCtxProp('open')).includes('cannot get property "open" without inject'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
