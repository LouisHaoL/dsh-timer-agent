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
import { HostJobStore } from '../src/host/store.ts'
import { TimerRunner } from '../src/host/runner.ts'
import { registerTimerTool } from '../src/host/tools.ts'
import { makeRoutes } from '../src/host/routes.ts'
import type {
  HostAgent, HostAgentHandle, HostPluginContext, HostRoute,
  NodeIncomingMessage, NodeServerResponse,
} from '../src/host/contracts.ts'
import { createJob, withSchedule, type JobRecord } from '../src/core/jobs.ts'

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

interface FakeCall { kind: 'create' | 'resume' | 'followup' | 'dispose'; sessionId?: string; prompt?: string; cwd?: string }

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
      cancel: () => {},
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
  const created = await tool.execute({ action: 'create', name: 'daily', prompt: 'standup', schedule: '0 9 * * *' }) as { job?: { id?: string } }
  const jobId = created.job?.id
  check('create returns job summary', typeof jobId === 'string' && jobId !== '')
  const row = (await s.load())[0]
  check('create persisted armed schedule', row?.schedule?.enabled === true && row?.schedule?.cron === '0 9 * * *')

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
  const badUpdate = await tool.execute({ action: 'update', job_id: 'nope', prompt: 'x' }) as { error?: string }
  check('update unknown id rejected', typeof badUpdate.error === 'string')

  // Webhook via the tool: enable → url+token; disable → cleared.
  const hook = await tool.execute({ action: 'webhook', job_id: jobId }) as { job?: { url?: string, webhook?: boolean } }
  check('tool webhook enable returns hook url', typeof hook.job?.url === 'string'
    && hook.job!.url!.includes('/api/dsh-timer-agent/hooks/run?id=')
    && hook.job!.url!.includes('token='))
  check('tool webhook enable persists the token', ((await s.load())[0]?.webhookToken ?? '').length === 36)
  const hookOff = await tool.execute({ action: 'webhook', job_id: jobId, webhook: false }) as { job?: { webhook?: boolean } }
  check('tool webhook disable clears it', hookOff.job?.webhook !== true && (await s.load())[0]?.webhookToken === undefined)

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
  const hookRoute = routes.find(r => r.path.endsWith('/hooks/run'))!
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

  // Webhook: enable via PATCH → token minted
  const hookCreated = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'hook-job' }), hookCreated.res)
  const hookId = (JSON.parse(hookCreated.body).job as JobRecord).id
  const hookEnabled = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${hookId}`, { webhookEnabled: true }), hookEnabled.res)
  const hookJob = JSON.parse(hookEnabled.body).job as JobRecord
  check('PATCH webhookEnabled mints a uuid token', hookEnabled.status === 200
    && typeof hookJob.webhookToken === 'string' && /^[0-9a-f-]{36}$/u.test(hookJob.webhookToken!))

  const hookUrl = (token: string): string => `/api/dsh-timer-agent/hooks/run?id=${encodeURIComponent(hookId)}&token=${encodeURIComponent(token)}`
  const badToken = makeRes()
  await hookRoute.handler(makeReq('POST', hookUrl('wrong-token')), badToken.res)
  check('hook with wrong token → 401', badToken.status === 401, `${badToken.status}`)
  const noToken = makeRes()
  await hookRoute.handler(makeReq('POST', `/api/dsh-timer-agent/hooks/run?id=${hookId}`), noToken.res)
  check('hook without token → 400', noToken.status === 400, `${noToken.status}`)
  const notEnabledJob = makeRes()
  await jobsRoute.handler(makeReq('POST', '/api/dsh-timer-agent/jobs', { title: 'plain-job' }), notEnabledJob.res)
  const plainId = (JSON.parse(notEnabledJob.body).job as JobRecord).id
  const notEnabled = makeRes()
  await hookRoute.handler(makeReq('POST', `/api/dsh-timer-agent/hooks/run?id=${plainId}&token=whatever`), notEnabled.res)
  check('hook on job without webhook → 403', notEnabled.status === 403, `${notEnabled.status}`)
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${plainId}`), makeRes().res)
  const unknown = makeRes()
  await hookRoute.handler(makeReq('POST', '/api/dsh-timer-agent/hooks/run?id=nope&token=x'), unknown.res)
  check('hook on unknown job → 404', unknown.status === 404, `${unknown.status}`)

  // THE POINT of the route: an EXTERNAL (non-loopback) caller with the
  // token fires the job — no loopback fence here.
  const external = makeRes()
  await hookRoute.handler(makeReq('POST', hookUrl(hookJob.webhookToken!), undefined, '192.168.1.5'), external.res)
  check('external caller with valid token → 202', external.status === 202, `${external.status}`)
  check('hook fire started the run', (await s.load()).some(j => j.id === hookId && j.status === 'running'))
  const whileRunning = makeRes()
  await hookRoute.handler(makeReq('GET', hookUrl(hookJob.webhookToken!)), whileRunning.res)
  check('hook while running → 409', whileRunning.status === 409, `${whileRunning.status}`)

  // Disabling kills the hook.
  const hookDisabled = makeRes()
  await jobsRoute.handler(makeReq('PATCH', `/api/dsh-timer-agent/jobs?id=${hookId}`, { webhookEnabled: false, resetStatus: true }), hookDisabled.res)
  check('PATCH webhookEnabled=false clears the token', (JSON.parse(hookDisabled.body).job as JobRecord).webhookToken === undefined)
  const afterDisable = makeRes()
  await hookRoute.handler(makeReq('POST', hookUrl(hookJob.webhookToken!)), afterDisable.res)
  check('disabled hook → 403 even with the old token', afterDisable.status === 403, `${afterDisable.status}`)
  await jobsRoute.handler(makeReq('DELETE', `/api/dsh-timer-agent/jobs?id=${hookId}`), makeRes().res)

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
}

// ============================================================================
rmSync(tempDir, { recursive: true, force: true })
console.log(`\n== results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
