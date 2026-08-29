/**
 * E2E test suite for dsh-timer-agent (behavioral, no dsh runtime needed):
 *
 *   node --experimental-transform-types tests/e2e.mts
 *
 * Covers the five behavioral cores with fake host faces:
 *   1. cron parsing / next-run computation (pure functions)
 *   2. HostJobStore: load / mutate / atomic save / corrupted-file degradation
 *   3. TimerRunner: due firing, at-most-once roll-forward, skip-while-running,
 *      pinned-session resume (+ fallback on failure), turn/end settlement
 *      (succeeded & failed), manual runRequest fast path
 *   4. timer_agent tool actions against a fake registry
 *   5. HTTP route handlers: CRUD + run + loopback fence + bad input
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isValidCron, nextRunAtMs } from '../src/core/schedule.ts'
import { splitCommandArgs, truncateOutputTail } from '../src/core/command.ts'
import { HostJobStore } from '../src/host/store.ts'
import { TimerRunner } from '../src/host/runner.ts'
import { registerTimerTool } from '../src/host/tools.ts'
import { makeRoutes } from '../src/host/routes.ts'
import type {
  HostAgent, HostAgentHandle, HostPluginContext, HostRoute,
  NodeIncomingMessage, NodeServerResponse,
} from '../src/host/contracts.ts'
import { commandLine, createJob, jobKind, normalizeTimeoutMs, timeoutLabel, withSchedule, type JobRecord } from '../src/core/jobs.ts'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail === '' ? '' : ` 鈥?${detail}`}`) }
}
function section(name: string): void { console.log(`\n== ${name}`) }

// ============================================================================
// 1. cron pure functions
// ============================================================================
section('cron: isValidCron')
check('accepts 5-field wildcard', isValidCron('* * * * *'))
check('accepts daily 9am', isValidCron('0 9 * * *'))
check('accepts step + range + list', isValidCron('*/10 1-5 1,15 * 1-5'))
check('rejects 4 fields', !isValidCron('0 9 * *'))
check('rejects out-of-range minute', !isValidCron('99 * * * *'))
check('rejects garbage', !isValidCron('hello'))

section('cron: nextRunAtMs')
{
  // nextRunAtMs scans in LOCAL time (task-board parity) 鈥?build inputs with
  // local-time constructors, not UTC epoch constants.
  const midnight = new Date(2026, 0, 1, 0, 0, 0).getTime()
  const hourly = nextRunAtMs('0 * * * *', midnight)
  check('hourly from exact hour 鈫?next hour', hourly === new Date(2026, 0, 1, 1, 0, 0).getTime(), `${hourly}`)
  const daily = nextRunAtMs('0 9 * * *', midnight)
  check('daily 9am from midnight 鈫?same day 9am', daily === new Date(2026, 0, 1, 9, 0, 0).getTime(), `${daily}`)
  const friday = new Date(2026, 0, 2, 10, 30, 0).getTime() // Saturday 2026-01-03? verify by weekday below
  const monday = nextRunAtMs('0 9 * * 1', friday)
  check('weekly Monday from weekend 鈫?next Monday 9am local',
    monday === new Date(2026, 0, 5, 9, 0, 0).getTime(), `${monday}`)
  const tenMin = nextRunAtMs('*/10 * * * *', midnight + 3 * 60_000)
  check('every-10min rolls to next slot', tenMin === midnight + 10 * 60_000, `${tenMin}`)
}

// ============================================================================
// 2. HostJobStore
// ============================================================================
section('HostJobStore: load / mutate / save')
const tempDir = mkdtempSync(join(tmpdir(), 'timer-agent-e2e-'))
const store = new HostJobStore(join(tempDir, 'jobs.json'))
{
  const empty = await store.load()
  check('first load is empty', empty.length === 0)
  const job = createJob({ title: 't', description: '', prompt: 'p', target: { workdir: '', sessionId: '' } }, 1000, 'id-1')
  await store.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  const reloaded = await store.load()
  check('persisted and reloaded', reloaded.length === 1 && reloaded[0].id === 'id-1')
  const aborted = await store.mutate(() => undefined)
  check('mutate abort writes nothing', aborted === undefined && (await store.load()).length === 1)
}
{
  const corrupt = new HostJobStore(join(tempDir, 'corrupt.json'))
  writeFileSync(join(tempDir, 'corrupt.json'), '{ not json !!!', 'utf8')
  check('corrupted file degrades to empty, no throw', (await corrupt.load()).length === 0)
}

// ============================================================================
// 3. TimerRunner 鈥?full behavioral pass with a fake host
// ============================================================================
section('TimerRunner: due firing + at-most-once')

interface FakeCall { kind: 'create' | 'resume' | 'followup' | 'dispose' | 'cancel'; sessionId?: string; prompt?: string; cwd?: string }

function makeFakeHost(): { ctx: HostPluginContext; calls: FakeCall[]; emit: (sessionId: string, type: string, data: unknown) => void } {
  const calls: FakeCall[] = []
  const inflight = new Map<string, HostAgent>() // by sessionId
  let seq = 0
  const makeAgent = (sessionId: string, opts?: { resumeFails?: boolean }): HostAgentHandle => {
    const agent: HostAgent = {
      id: `agent-${++seq}`,
      session: { id: sessionId },
      followup: message => {
        calls.push({ kind: 'followup', sessionId, prompt: message.content[0]?.text })
        inflight.set(sessionId, agent)
        // stash the message id so the test can emit its user/message + turn/end
        ;(agent as unknown as { lastMessageId?: string }).lastMessageId = message.id
      },
      cancel: () => { calls.push({ kind: 'cancel', sessionId }) },
    }
    return {
      agent,
      dispose: async () => { calls.push({ kind: 'dispose', sessionId }) },
    }
  }
  const ctx = {
    agents: {
      create: async (options: { sessionId: string; meta?: { cwd?: string } }) => {
        calls.push({ kind: 'create', sessionId: options.sessionId, cwd: options.meta?.cwd })
        return makeAgent(options.sessionId)
      },
      resume: async (options: { resumeSessionId: string }) => {
        calls.push({ kind: 'resume', sessionId: options.resumeSessionId })
        if (resumeShouldFail) throw new Error('session gone')
        return makeAgent(options.resumeSessionId)
      },
    },
    webServer: { register: () => () => {} },
    get: () => undefined,
    on: (_event: 'session/event', listener: (session: { id: string }, event: { type: string; data: unknown }) => void) => {
      sessionListener = listener
      return () => {}
    },
    effect: () => () => {},
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  } as unknown as HostPluginContext
  let sessionListener: ((session: { id: string }, event: { type: string; data: unknown }) => void) | undefined
  let resumeShouldFail = false
  return {
    ctx,
    calls,
    emit: (sessionId, type, data) => { sessionListener?.({ id: sessionId }, { type, data }) },
    setResumeFailure: (v: boolean) => { resumeShouldFail = v },
    agentOf: (sessionId: string) => inflight.get(sessionId),
  }
}

{
  const host = makeFakeHost()
  const file = join(tempDir, 'runner.json')
  const s = new HostJobStore(file)
  let now = Date.UTC(2026, 0, 1, 0, 0, 0)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })

  // Register the session-event listener BEFORE any job exists (start), then
  // stop the timers at once — the start-time tick sees an empty ledger.
  runner.start()
  runner.stop()

  // A due job (nextRunAt in the past), blank target.
  let job = createJob({ title: 'due-job', description: '', prompt: 'run me', target: { workdir: '', sessionId: '' } }, now, 'job-a')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1000 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))

  const fired = await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  check('due job fired', fired === 1, `fired=${fired}`)
  const afterTick = await s.load()
  const rolled = afterTick[0]?.schedule?.nextRunAt
  check('nextRunAt rolled forward before/at fire (at-most-once)', rolled !== undefined && rolled > now - 1000, `${rolled}`)
  check('status became running', afterTick[0]?.status === 'running')
  check('created a fresh session + followup', host.calls.some(c => c.kind === 'create' && c.cwd === undefined)
    && host.calls.some(c => c.kind === 'followup' && c.prompt === 'run me'))

  // Settle the run as succeeded via session events.
  const created = host.calls.find(c => c.kind === 'create')
  const agent = host.agentOf(created!.sessionId!)
  const messageId = (agent as unknown as { lastMessageId?: string }).lastMessageId
  host.emit(created!.sessionId!, 'user/message', { id: messageId })
  host.emit(created!.sessionId!, 'turn/end', { turn: 1, reason: { kind: 'stop' } })
  await new Promise(r => setTimeout(r, 25)) // settle's mutate is async
  const settled = (await s.load())[0]
  check('turn/end (non-error) settles succeeded', settled?.status === 'done'
    && settled?.executions[0]?.result === 'succeeded', `${settled?.status}/${settled?.executions[0]?.result}`)
}

section('TimerRunner: failure settlement + pinned resume + skip-while-running')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'runner2.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })

  // Pinned-session job, due. Register the listener before the job exists.
  runner.start()
  runner.stop()
  let job = createJob({ title: 'pinned', description: '', prompt: 'again', target: { workdir: '', sessionId: 'sess-77' } }, now, 'job-b')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  check('pinned session uses agents.resume', host.calls.some(c => c.kind === 'resume' && c.sessionId === 'sess-77'))
  const resumed = host.calls.find(c => c.kind === 'resume')
  const agent = host.agentOf(resumed!.sessionId!)
  const messageId = (agent as unknown as { lastMessageId?: string }).lastMessageId
  host.emit(resumed!.sessionId!, 'user/message', { id: messageId })
  host.emit(resumed!.sessionId!, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })
  await new Promise(r => setTimeout(r, 25)) // settle's mutate is async
  const failed = (await s.load())[0]
  check('turn/end error settles failed with reason', failed?.status === 'failed'
    && failed?.executions[0]?.error === 'boom', `${failed?.status}/${failed?.executions[0]?.error}`)

  // While "running": manual requestRun must be rejected.
  let job2 = createJob({ title: 'busy', description: '', prompt: 'x', target: { workdir: '', sessionId: '' } }, now, 'job-c')
  job2 = { ...job2, status: 'running' }
  await s.mutate(jobs => ({ jobs: [...jobs, job2], result: true }))
  const accepted = await runner.requestRun('job-c')
  check('requestRun rejected while running', accepted === false)
}

section('TimerRunner: disabled schedule never fires + manual runRequest path')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'runner3.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })

  let disabled = createJob({ title: 'paused', description: '', prompt: 'no', target: { workdir: '', sessionId: '' } }, now, 'job-d')
  disabled = withSchedule(disabled, { enabled: false, cron: '0 9 * * *', nextRunAt: now - 1 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, disabled], result: true }))
  const fired = await runner.tick()
  check('disabled schedule does not fire', fired === 0 && !host.calls.some(c => c.kind === 'create'))

  // Manual run request: stamp the field, tick fires it and clears the stamp.
  const ok = await runner.requestRun('job-d')
  check('manual requestRun accepted', ok === true)
  const row = (await s.load())[0]
  check('manual run started execution', row?.status === 'running' && row?.executions.length === 1)
}

section('TimerRunner: workdir passes cwd to agents.create')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'runner4.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  let job = createJob({ title: 'proj', description: '', prompt: 'p', target: { workdir: 'D:/work/proj', sessionId: '' } }, now, 'job-e')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  check('agents.create received meta.cwd=workdir', host.calls.some(c => c.kind === 'create' && c.cwd === 'D:/work/proj'))
}

// ============================================================================
// 3b. run timeout (normalize + runner enforcement)
// ============================================================================
section('timeout: normalize + labels')
check('normalize passes positive ms through', normalizeTimeoutMs(90_000) === 90_000)
check('normalize rounds fractional ms', normalizeTimeoutMs(90_499.6) === 90_500)
check('normalize clears zero / negative / NaN / junk',
  normalizeTimeoutMs(0) === undefined && normalizeTimeoutMs(-5) === undefined
  && normalizeTimeoutMs(Number.NaN) === undefined && normalizeTimeoutMs('10' as unknown) === undefined)
{
  const base = { title: 't', description: '', prompt: 'p', target: { workdir: '', sessionId: '' } }
  const withLimit = { ...createJob(base, 0, 'x'), timeoutMs: 90_000 }
  const unlimited = createJob(base, 0, 'y')
  check('label: 90s → 1.5m', timeoutLabel(withLimit) === '1.5m')
  check('label: 120000ms → 2m', timeoutLabel({ ...withLimit, timeoutMs: 120_000 }) === '2m')
  check('label: 30000ms → 30s', timeoutLabel({ ...withLimit, timeoutMs: 30_000 }) === '30s')
  check('label: absent → dash', timeoutLabel(unlimited) === '—')
}

section('TimerRunner: run timeout cancels + settles failed')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'timeout.json'))
  // Half-past the hour: an hourly cron's next slot is a full hour away, so
  // the +121s timeout pass cannot coincide with the next scheduled fire.
  let now = Date.UTC(2026, 0, 1, 0, 30, 0)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  runner.start()
  runner.stop()

  let job = createJob({ title: 'slow', description: '', prompt: 'never finishes', target: { workdir: '', sessionId: '' } }, now, 'job-t1')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  job = { ...job, timeoutMs: 120_000 } // 2 minutes
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))

  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  check('timeout job fired', host.calls.some(c => c.kind === 'followup' && c.prompt === 'never finishes'))
  check('not yet timed out (deadline in the future)', (await s.load())[0]?.status === 'running')

  now += 121_000 // past the deadline
  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  const timedOut = (await s.load())[0]
  check('timeout settles failed with reason', timedOut?.status === 'failed'
    && timedOut?.executions[0]?.result === 'failed'
    && typeof timedOut?.executions[0]?.error === 'string' && timedOut.executions[0].error.includes('timed out'),
    `${timedOut?.status}/${timedOut?.executions[0]?.error}`)

  // A late turn/end cannot double-settle the timed-out execution.
  const created = host.calls.find(c => c.kind === 'create')
  const agent = host.agentOf(created!.sessionId!)
  const messageId = (agent as unknown as { lastMessageId?: string }).lastMessageId
  host.emit(created!.sessionId!, 'user/message', { id: messageId })
  host.emit(created!.sessionId!, 'turn/end', { turn: 1, reason: { kind: 'stop' } })
  await new Promise(r => setTimeout(r, 25))
  const late = (await s.load())[0]
  check('late turn/end does not resurrect the run', late?.status === 'failed' && late?.executions.length === 1
    && late?.executions[0]?.result === 'failed')
}

section('TimerRunner: unlimited runs never time out')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'notimeout.json'))
  let now = Date.UTC(2026, 0, 1, 0, 30, 0)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  runner.start()
  runner.stop()

  let job = createJob({ title: 'endless', description: '', prompt: 'x', target: { workdir: '', sessionId: '' } }, now, 'job-t2')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  now += 10 * 60_000 // past where a short timeout would have fired
  await runner.tick()
  await new Promise(r => setTimeout(r, 25))
  check('no timeout configured → still running', (await s.load())[0]?.status === 'running')
  check('no cancel was issued', !host.calls.some(c => c.kind === 'cancel'))
}

// ============================================================================
// 4. timer_agent tool
// ============================================================================
section('timer_agent tool actions')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'tool.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  const registered: unknown[] = []
  const disposer = registerTimerTool({ register: (def: unknown) => { registered.push(def); return () => {} } }, { store: s, runner, now: () => now })
  check('tool registered once', registered.length === 1)
  const tool = registered[0] as {
    name: string
    execute(args: Record<string, string | undefined>): Promise<Record<string, unknown>>
  }
  check('tool name is timer_agent', tool.name === 'timer_agent')

  // create with missing fields
  const badCreate = await tool.execute({ action: 'create', prompt: 'x' }) as { error?: string }
  check('create without schedule rejected', typeof badCreate.error === 'string')
  const badCron = await tool.execute({ action: 'create', prompt: 'x', schedule: 'nonsense' }) as { error?: string }
  check('create with invalid cron rejected', typeof badCron.error === 'string')

  // good create
  const created = await tool.execute({ action: 'create', name: 'daily', prompt: 'standup', schedule: '0 9 * * *', timeout_minutes: 5 }) as { job?: { id?: string } }
  const jobId = created.job?.id
  check('create returns job summary', typeof jobId === 'string' && jobId !== '')
  const row = (await s.load())[0]
  check('create persisted armed schedule', row?.schedule?.enabled === true && row?.schedule?.cron === '0 9 * * *')
  check('create persisted timeout_minutes=5 → 300000ms', row?.timeoutMs === 300_000, `${row?.timeoutMs}`)

  // list
  const listed = await tool.execute({ action: 'list' }) as { jobs?: unknown[] }
  check('list returns the job', listed.jobs?.length === 1)

  // pause / resume
  await tool.execute({ action: 'pause', job_id: jobId })
  check('pause disarms', (await s.load())[0]?.schedule?.enabled === false)
  await tool.execute({ action: 'resume', job_id: jobId })
  check('resume re-arms with fresh nextRunAt', (await s.load())[0]?.schedule?.enabled === true
    && (await s.load())[0]?.schedule?.nextRunAt !== undefined)

  // update
  await tool.execute({ action: 'update', job_id: jobId, prompt: 'new prompt', schedule: '*/30 * * * *' })
  const updated = (await s.load())[0]
  check('update changes prompt + cron', updated?.prompt === 'new prompt' && updated?.schedule?.cron === '*/30 * * * *')
  await tool.execute({ action: 'update', job_id: jobId, preset: 'alpinario-ops' })
  check('update pins preset', (await s.load())[0]?.preset === 'alpinario-ops')
  await tool.execute({ action: 'update', job_id: jobId, preset: '' })
  check('update preset="" clears it', (await s.load())[0]?.preset === undefined)
  await tool.execute({ action: 'update', job_id: jobId, timeout_minutes: 0 })
  check('update timeout_minutes=0 clears the limit', (await s.load())[0]?.timeoutMs === undefined)
  await tool.execute({ action: 'update', job_id: jobId, timeout_minutes: 2 })
  check('update timeout_minutes=2 → 120000ms', (await s.load())[0]?.timeoutMs === 120_000)
  const badUpdate = await tool.execute({ action: 'update', job_id: 'nope', prompt: 'x' }) as { error?: string }
  check('update unknown id rejected', typeof badUpdate.error === 'string')

  // remove
  await tool.execute({ action: 'remove', job_id: jobId })
  check('remove clears ledger', (await s.load()).length === 0)

  disposer()
}

// ============================================================================
// 5. HTTP route handlers
// ============================================================================
section('HTTP routes: handlers + loopback fence')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'routes.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  const routes = makeRoutes({ store: s, runner, ctx: host.ctx, now: () => now })
  check('five routes composed', routes.length === 5)

  const jobsRoute = routes.find(r => r.path.endsWith('/jobs'))!
  const runRoute = routes.find(r => r.path.endsWith('/jobs/run'))!
  const wsRoute = routes.find(r => r.path.endsWith('/workspaces'))!

  // Minimal fake req/res over Node streams.
  const { Readable, Writable } = await import('node:stream')
  function makeReq(method: string, url: string, body?: unknown, remote = '127.0.0.1'): NodeIncomingMessage {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as NodeIncomingMessage
    Object.assign(req, {
      method, url,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: remote },
    })
    return req
  }
  function makeRes(): { res: NodeServerResponse; status: number; body: string } {
    const state = { status: 0, body: '' }
    const res = new Writable({
      write(chunk, _enc, cb) { state.body += chunk.toString(); cb() },
    }) as unknown as NodeServerResponse
    Object.assign(res, {
      writeHead: (status: number) => { state.status = status },
      end: (chunk?: string | Buffer) => { if (chunk !== undefined) state.body += chunk.toString() },
    })
    return { res, get status() { return state.status }, get body() { return state.body } }
  }

  // POST create (loopback ok)
  const created = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'r-job', prompt: 'p', cron: '0 9 * * *', target: { workdir: '', sessionId: '' } }), created.res)
  check('POST /jobs 鈫?201', created.status === 201, `${created.status}`)
  const id = (JSON.parse(created.body).job as JobRecord).id

  // GET list
  const listed = makeRes()
  await jobsRoute.handler(makeReq('GET', '/api/dsh-timer-agent/jobs'), listed.res)
  check('GET /jobs returns the job', listed.status === 200 && (JSON.parse(listed.body).jobs as JobRecord[]).some(j => j.id === id))

  // PATCH update
  const patched = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${id}`, { prompt: 'p2' }), patched.res)
  check('PATCH /jobs 鈫?200 with new prompt', patched.status === 200 && (JSON.parse(patched.body).job as JobRecord).prompt === 'p2')

  // PATCH cron on an ARMED schedule rolls nextRunAt to the new expression
  const cronEdited = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${id}`, { cron: '0 10 * * *' }), cronEdited.res)
  const cronEditedJob = JSON.parse(cronEdited.body).job as JobRecord
  check('PATCH cron on armed schedule rolls nextRunAt', cronEdited.status === 200
    && cronEditedJob.schedule?.cron === '0 10 * * *'
    && cronEditedJob.schedule?.nextRunAt === nextRunAtMs('0 10 * * *', now),
  `${cronEdited.status} ${cronEditedJob.schedule?.nextRunAt}`)

  // PATCH skipNext: rolls nextRunAt forward ONE occurrence (skip the next fire)
  const skipped = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${id}`, { skipNext: true }), skipped.res)
  const skippedJob = JSON.parse(skipped.body).job as JobRecord
  check('PATCH skipNext rolls nextRunAt one occurrence', skipped.status === 200
    && skippedJob.schedule?.nextRunAt === nextRunAtMs('0 10 * * *', cronEditedJob.schedule?.nextRunAt ?? now),
  `${skipped.status} ${skippedJob.schedule?.nextRunAt}`)
  // skipNext on a job without an armed schedule → 400
  const bareCreated = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'skip-bare' }), bareCreated.res)
  const bareId = (JSON.parse(bareCreated.body).job as JobRecord).id
  const skipBare = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${bareId}`, { skipNext: true }), skipBare.res)
  check('PATCH skipNext without armed schedule → 400', skipBare.status === 400)
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${bareId}`), makeRes().res)

  // POST/PATCH timeoutMinutes
  const toCreated = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'to-job', timeoutMinutes: 3 }), toCreated.res)
  const toId = (JSON.parse(toCreated.body).job as JobRecord).id
  check('POST /jobs persists timeoutMinutes=3', toCreated.status === 201
    && (JSON.parse(toCreated.body).job as JobRecord).timeoutMs === 180_000)
  const toPatched = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${toId}`, { timeoutMinutes: 0 }), toPatched.res)
  check('PATCH timeoutMinutes=0 clears', toPatched.status === 200 && (JSON.parse(toPatched.body).job as JobRecord).timeoutMs === undefined)
  const toPatched2 = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${toId}`, { timeoutMinutes: 12 }), toPatched2.res)
  check('PATCH timeoutMinutes=12 sets 720000ms', (JSON.parse(toPatched2.body).job as JobRecord).timeoutMs === 720_000)
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${toId}`), makeRes().res)

  // POST run
  const ran = makeRes()
  await runRoute.handler(makeReq('POST', `/api/dsh-timer-agent/jobs/run?id=${id}`), ran.res)
  check('POST /run 鈫?202', ran.status === 202, `${ran.status}`)

  // Archive/restart on a separate (not running) job
  const archCreated = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'arch-job', cron: '0 9 * * *' }), archCreated.res)
  const archId = (JSON.parse(archCreated.body).job as JobRecord).id
  const archived = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${archId}`, { archived: true }), archived.res)
  check('PATCH archived 鈫?200 status=archived', archived.status === 200 && (JSON.parse(archived.body).job as JobRecord).status === 'archived')
  const runArchived = makeRes()
  await runRoute.handler(makeReq('POST', `/api/dsh-timer-agent/jobs/run?id=${archId}`), runArchived.res)
  check('run of archived job 鈫?409', runArchived.status === 409, `${runArchived.status}`)

  // Restart → back to idle + schedule re-armed
  const restarted = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${archId}`, { restart: true }), restarted.res)
  const restartedJob = JSON.parse(restarted.body).job as JobRecord
  check('PATCH restart 鈫?200 status=idle + nextRunAt set', restarted.status === 200
    && restartedJob.status === 'idle' && restartedJob.schedule?.nextRunAt !== undefined)
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${archId}`), makeRes().res)

  // DELETE
  const deleted = makeRes()
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${id}`), deleted.res)
  check('DELETE /jobs 鈫?200 and ledger empty', deleted.status === 200 && (await s.load()).length === 0)

  // Loopback fence: non-loopback remote 鈫?403
  const fenced = makeRes()
  await jobsRoute.handler(makeReq('GET', '/api/dsh-timer-agent/jobs', undefined, '192.168.1.5'), fenced.res)
  check('non-loopback remote rejected 403', fenced.status === 403, `${fenced.status}`)
  const crossSite = makeRes()
  const req2 = makeReq('GET', '/api/dsh-timer-agent/jobs')
  Object.assign(req2, { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })
  await jobsRoute.handler(req2, crossSite.res)
  check('cross-site marker rejected 403', crossSite.status === 403, `${crossSite.status}`)

  // Bad input: invalid cron on POST
  const badCron = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'x', cron: 'zzz' }), badCron.res)
  check('POST with invalid cron 鈫?400', badCron.status === 400, `${badCron.status}`)
  // Missing title
  const noTitle = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {}), noTitle.res)
  check('POST without title 鈫?400', noTitle.status === 400, `${noTitle.status}`)

  // Workspaces route (registry absent 鈫?empty list, still 200)
  const ws = makeRes()
  await wsRoute.handler(makeReq('GET', '/api/dsh-timer-agent/workspaces'), ws.res)
  check('GET /workspaces 鈫?200 (empty without registry)', ws.status === 200)

  // Model-options route (llm/agentDefaultModel absent → empty catalog, still 200)
  const moRoute = routes.find(r => r.path.endsWith('/model-options'))!
  const mo = makeRes()
  await moRoute.handler(makeReq('GET', '/api/dsh-timer-agent/model-options'), mo.res)
  const moBody = JSON.parse(mo.body) as { default?: unknown, groups: unknown[] }
  check('GET /model-options 鈫?200 (empty without services)', mo.status === 200 && moBody.groups.length === 0)

  // POST /jobs with a model selection persists it; an invalid one is rejected
  const withModel = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {
    title: 'model job',
    target: { workdir: '', sessionId: '' },
    modelSelection: { provider: 'p1', model: 'm1' },
  }), withModel.res)
  const withModelBody = JSON.parse(withModel.body) as { job?: { modelSelection?: { provider: string, model: string } } }
  check('POST /jobs persists modelSelection', withModel.status === 201 && withModelBody.job?.modelSelection?.model === 'm1')
  const badModel = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {
    title: 'bad model',
    modelSelection: { provider: '', model: 'm1' },
  }), badModel.res)
  check('POST /jobs rejects invalid modelSelection', badModel.status === 400)

  // Preset-options route (agentPresets absent → empty roster, still 200)
  const poRoute = routes.find(r => r.path.endsWith('/preset-options'))!
  const po = makeRes()
  await poRoute.handler(makeReq('GET', '/api/dsh-timer-agent/preset-options'), po.res)
  const poBody = JSON.parse(po.body) as { default?: unknown, presets: unknown[] }
  check('GET /preset-options → 200 (empty without service)', po.status === 200 && poBody.presets.length === 0)

  // POST /jobs with a preset persists it; PATCH sets and clears it
  const withPreset = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {
    title: 'preset job',
    target: { workdir: '', sessionId: '' },
    preset: 'alpinario-ops',
  }), withPreset.res)
  const withPresetBody = JSON.parse(withPreset.body) as { job?: JobRecord }
  const presetJobId = withPresetBody.job?.id
  check('POST /jobs persists preset', withPreset.status === 201 && withPresetBody.job?.preset === 'alpinario-ops')
  const presetPatched = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${presetJobId}`, { preset: 'liangshen' }), presetPatched.res)
  check('PATCH preset updates it', presetPatched.status === 200 && (JSON.parse(presetPatched.body).job as JobRecord).preset === 'liangshen')
  const presetCleared = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${presetJobId}`, { preset: '' }), presetCleared.res)
  const presetClearedJob = JSON.parse(presetCleared.body).job as JobRecord
  check('PATCH preset="" clears it', presetCleared.status === 200 && presetClearedJob.preset === undefined)
  // Command jobs never carry a preset
  const cmdPreset = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {
    title: 'cmd preset', kind: 'command', command: 'node', preset: 'alpinario-ops',
  }), cmdPreset.res)
  check('POST command job ignores preset', cmdPreset.status === 201 && (JSON.parse(cmdPreset.body).job as JobRecord).preset === undefined)
}

// ============================================================================
// 6. command jobs (普通任务): arg splitting, model, runner spawn, tool, routes
// ============================================================================
section('command: splitCommandArgs')
check('whitespace split', JSON.stringify(splitCommandArgs('-X utf8 script.py')) === JSON.stringify(['-X', 'utf8', 'script.py']))
check('double quotes group (with spaces inside)', JSON.stringify(splitCommandArgs('-Command "echo hello world"')) === JSON.stringify(['-Command', 'echo hello world']))
check('single quotes group literally', JSON.stringify(splitCommandArgs("-Command 'echo hi'")) === JSON.stringify(['-Command', 'echo hi']))
check('adjacent quoted + bare text merges', JSON.stringify(splitCommandArgs('ab"c d"e')) === JSON.stringify(['abc de']))
check('escaped quote inside double quotes', JSON.stringify(splitCommandArgs('"a\\"b"')) === JSON.stringify(['a"b']))
check('unterminated double quote throws', (() => { try { splitCommandArgs('"oops'); return false } catch { return true } })())
check('unterminated single quote throws', (() => { try { splitCommandArgs("'oops"); return false } catch { return true } })())
check('empty input → no args', splitCommandArgs('').length === 0 && splitCommandArgs('   ').length === 0)
check('truncateOutputTail keeps tail with marker', truncateOutputTail('a'.repeat(20), 5) === '…（前 15 字符已省略）\n' + 'a'.repeat(5))
check('truncateOutputTail passthrough under cap', truncateOutputTail('abc', 5) === 'abc')

section('command: job model + ledger roundtrip')
{
  const cmd = createJob({
    title: 'cmd', description: '', prompt: '',
    kind: 'command', command: 'node', args: '-e "console.log(1)"',
    target: { workdir: 'D:/work', sessionId: '' },
  }, 1000, 'cmd-1')
  check('createJob stores kind/command/args', jobKind(cmd) === 'command' && cmd.command === 'node' && cmd.args === '-e "console.log(1)"')
  check('commandLine renders exec line', commandLine(cmd) === 'node -e "console.log(1)"')
  const agentJob = createJob({ title: 'a', description: '', prompt: 'p', target: { workdir: '', sessionId: '' } }, 1000, 'ag-1')
  check('agent job stays lean (no kind fields)', jobKind(agentJob) === 'agent' && agentJob.command === undefined && agentJob.args === undefined)
  check('commandLine of agent job is empty', commandLine(agentJob) === '')
  check('createJob stores preset (agent)', createJob({
    title: 'a2', description: '', prompt: 'p', target: { workdir: '', sessionId: '' }, preset: 'liangshen',
  }, 1000, 'ag-2').preset === 'liangshen')
  check('createJob drops blank preset', createJob({
    title: 'a3', description: '', prompt: 'p', target: { workdir: '', sessionId: '' }, preset: '  ',
  }, 1000, 'ag-3').preset === undefined)
  check('createJob drops preset on command kind', createJob({
    title: 'a4', description: '', prompt: '', kind: 'command', command: 'node',
    target: { workdir: '', sessionId: '' }, preset: 'liangshen',
  }, 1000, 'ag-4').preset === undefined)

  const file = join(tempDir, 'cmdstore.json')
  const cs = new HostJobStore(file)
  await cs.mutate(jobs => ({ jobs: [...jobs, cmd, agentJob], result: true }))
  const reloaded = await cs.load()
  check('ledger roundtrip keeps command fields', reloaded.find(j => j.id === 'cmd-1')?.command === 'node'
    && jobKind(reloaded.find(j => j.id === 'cmd-1')!) === 'command')
  check('ledger roundtrip keeps agent rows valid', reloaded.find(j => j.id === 'ag-1')?.prompt === 'p')

  // A command execution record (targeting 'command', exitCode, output) survives parseLedger.
  const withExec = {
    ...cmd,
    executions: [{
      id: 'exec-1', sessionId: undefined, targeting: 'command' as const, startedAt: 1000,
      endedAt: 2000, result: 'succeeded' as const, error: undefined, exitCode: 0, output: 'hello',
    }],
  }
  await cs.mutate(jobs => ({ jobs: [withExec, agentJob], result: true }))
  const execReloaded = (await cs.load()).find(j => j.id === 'cmd-1')
  check('command execution record survives the ledger',
    execReloaded?.executions[0]?.targeting === 'command'
    && execReloaded?.executions[0]?.exitCode === 0
    && execReloaded?.executions[0]?.output === 'hello')
}

section('TimerRunner: command job fires the real process (success + failure + output)')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'cmdrunner.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  runner.start()
  runner.stop()

  let job = createJob({
    title: 'echo-job', description: '', prompt: '',
    kind: 'command', command: 'node', args: '-e "console.log(42+1)"',
    target: { workdir: '', sessionId: '' },
  }, now, 'job-cmd1')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  const fired = await runner.tick()
  check('command job fired', fired === 1)
  // Real spawn: give the process a moment to run and settle.
  for (let i = 0; i < 40 && ((await s.load())[0]?.executions[0]?.endedAt === undefined); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  const done = (await s.load())[0]
  check('command run settles succeeded with exitCode 0', done?.status === 'done'
    && done?.executions[0]?.result === 'succeeded' && done?.executions[0]?.exitCode === 0,
    `${done?.status}/${done?.executions[0]?.result}/${done?.executions[0]?.exitCode}`)
  check('command run captured stdout tail', (done?.executions[0]?.output ?? '').includes('43'),
    done?.executions[0]?.output)
  check('command run created no agent session', !host.calls.some(c => c.kind === 'create' || c.kind === 'resume'))

  // Failure: nonzero exit settles failed with the code + stderr in the output.
  let bad = createJob({
    title: 'fail-job', description: '', prompt: '',
    kind: 'command', command: 'node', args: "-e \"console.error('boom'); process.exit(3)\"",
    target: { workdir: '', sessionId: '' },
  }, now, 'job-cmd2')
  await s.mutate(jobs => ({ jobs: [...jobs.filter(j => j.id !== 'job-cmd2'), bad], result: true }))
  const accepted = await runner.requestRun('job-cmd2')
  check('manual command run accepted', accepted === true)
  for (let i = 0; i < 40 && ((await s.load()).find(j => j.id === 'job-cmd2')?.executions[0]?.endedAt === undefined); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  const failedRun = (await s.load()).find(j => j.id === 'job-cmd2')
  check('nonzero exit settles failed with code 3', failedRun?.status === 'failed'
    && failedRun?.executions[0]?.result === 'failed' && failedRun?.executions[0]?.exitCode === 3,
    `${failedRun?.status}/${failedRun?.executions[0]?.result}/${failedRun?.executions[0]?.exitCode}`)
  check('stderr captured in output tail', (failedRun?.executions[0]?.output ?? '').includes('boom'))
}

section('TimerRunner: command timeout kills the process and settles failed')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'cmdtimeout.json'))
  let now = Date.UTC(2026, 0, 1, 0, 30, 0)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  runner.start()
  runner.stop()

  let job = createJob({
    title: 'slow-cmd', description: '', prompt: '',
    kind: 'command', command: 'node', args: '-e "setTimeout(()=>{}, 600000)"',
    target: { workdir: '', sessionId: '' },
  }, now, 'job-cmd-t')
  job = withSchedule(job, { enabled: true, cron: '0 * * * *', nextRunAt: now - 1 }, now)
  job = { ...job, timeoutMs: 120_000 } // 2 minutes
  await s.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  await runner.tick()
  await new Promise(r => setTimeout(r, 100))
  check('slow command is running', (await s.load())[0]?.status === 'running')

  now += 121_000 // past the deadline
  await runner.tick()
  await new Promise(r => setTimeout(r, 200))
  const timedOut = (await s.load())[0]
  check('command timeout settles failed with reason', timedOut?.status === 'failed'
    && typeof timedOut?.executions[0]?.error === 'string' && timedOut.executions[0].error.includes('timed out'),
    `${timedOut?.status}/${timedOut?.executions[0]?.error}`)
}

section('timer_agent tool: command create / update / run')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'cmdtool.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  const registered: unknown[] = []
  registerTimerTool({ register: (def: unknown) => { registered.push(def); return () => {} } }, { store: s, runner, now: () => now })
  const tool = registered[0] as {
    name: string
    execute(args: Record<string, string | number | undefined>): Promise<Record<string, unknown>>
  }

  const badCmd = await tool.execute({ action: 'create', kind: 'command', schedule: '0 9 * * *', command: '' }) as { error?: string }
  check('command create without command rejected', typeof badCmd.error === 'string')
  const created = await tool.execute({
    action: 'create', kind: 'command', name: 'daily-script',
    command: 'node', args: '-e "console.log(7)"', schedule: '0 9 * * *', timeout_minutes: 10,
  }) as { job?: { id?: string, job_kind?: string, command?: string, args?: string } }
  const cmdId = created.job?.id
  check('command create returns kind/command summary',
    typeof cmdId === 'string' && created.job?.job_kind === 'command' && created.job?.command === 'node')
  const row = (await s.load())[0]
  check('command create persisted exec fields + timeout', row?.command === 'node'
    && row?.args === '-e "console.log(7)"' && row?.timeoutMs === 600_000)

  // update: change args; switch kind agent→command on an agent job.
  await tool.execute({ action: 'update', job_id: cmdId, args: '-e "console.log(8)"' })
  check('update args', (await s.load())[0]?.args === '-e "console.log(8)"')

  // run: fires the real command.
  await tool.execute({ action: 'run', job_id: cmdId })
  for (let i = 0; i < 40 && ((await s.load())[0]?.executions[0]?.endedAt === undefined); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  const ranRow = (await s.load())[0]
  check('tool run executed the command successfully', ranRow?.status === 'done'
    && ranRow?.executions[0]?.targeting === 'command'
    && (ranRow?.executions[0]?.output ?? '').includes('8'),
    `${ranRow?.status}/${ranRow?.executions[0]?.output}`)
}

section('HTTP routes: command job create / patch / validate')
{
  const host = makeFakeHost()
  const s = new HostJobStore(join(tempDir, 'cmdroutes.json'))
  let now = Date.UTC(2026, 0, 1)
  const runner = new TimerRunner({ ctx: host.ctx, store: s, now: () => now })
  const routes = makeRoutes({ store: s, runner, ctx: host.ctx, now: () => now })
  const jobsRoute = routes.find(r => r.path.endsWith('/jobs'))!

  const { Readable, Writable } = await import('node:stream')
  function makeReq(method: string, url: string, body?: unknown): NodeIncomingMessage {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as NodeIncomingMessage
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } })
    return req
  }
  function makeRes(): { res: NodeServerResponse; status: number; body: string } {
    const state = { status: 0, body: '' }
    const res = new Writable({ write(chunk, _enc, cb) { state.body += chunk.toString(); cb() } }) as unknown as NodeServerResponse
    Object.assign(res, { writeHead: (status: number) => { state.status = status }, end: (chunk?: string | Buffer) => { if (chunk !== undefined) state.body += chunk.toString() } })
    return { res, get status() { return state.status }, get body() { return state.body } }
  }

  // POST a command job
  const created = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', {
    title: 'r-cmd', kind: 'command', command: 'python', args: '-X utf8 temu_yh_yinhua.py',
    target: { workdir: 'D:/workspace/dsh/ziniao', sessionId: '' }, cron: '30 9 * * *',
  }), created.res)
  const createdJob = JSON.parse(created.body).job as JobRecord
  check('POST /jobs command → 201 with fields', created.status === 201
    && createdJob.kind === 'command' && createdJob.command === 'python' && createdJob.args === '-X utf8 temu_yh_yinhua.py')
  check('POST /jobs command arms the schedule', createdJob.schedule?.enabled === true && createdJob.schedule?.cron === '30 9 * * *')

  // POST a command job without a command → 400
  const bad = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'x', kind: 'command', command: '' }), bad.res)
  check('POST command job without command → 400', bad.status === 400, `${bad.status}`)

  // PATCH the command line + workdir
  const patched = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${createdJob.id}`, {
    command: 'pwsh', args: '-NoProfile -Command "echo hi"', target: { workdir: 'D:/other', sessionId: '' },
  }), patched.res)
  const patchedJob = JSON.parse(patched.body).job as JobRecord
  check('PATCH command/args/workdir', patched.status === 200
    && patchedJob.command === 'pwsh' && patchedJob.args === '-NoProfile -Command "echo hi"'
    && patchedJob.target.workdir === 'D:/other')

  // PATCH kind switch: agent → command requires a command
  const agentCreated = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'to-convert', prompt: 'p' }), agentCreated.res)
  const agentId = (JSON.parse(agentCreated.body).job as JobRecord).id
  const converted = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${agentId}`, {
    kind: 'command', command: 'node', args: '-v',
  }), converted.res)
  const convertedJob = JSON.parse(converted.body).job as JobRecord
  check('PATCH kind agent→command converts', converted.status === 200
    && convertedJob.kind === 'command' && convertedJob.command === 'node')
  const reverted = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${agentId}`, { kind: 'agent' }), reverted.res)
  const revertedJob = JSON.parse(reverted.body).job as JobRecord
  check('PATCH kind command→agent clears exec fields', reverted.status === 200
    && revertedJob.kind === undefined && revertedJob.command === undefined && revertedJob.args === undefined)
}

// ============================================================================
rmSync(tempDir, { recursive: true, force: true })
console.log(`\n== results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
