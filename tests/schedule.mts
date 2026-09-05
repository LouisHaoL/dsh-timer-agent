/**
 * Scheduling test suite for dsh-timer-agent (plain Node, no dsh runtime):
 *
 *   node --experimental-transform-types tests/schedule.mts
 *
 * Covers the fixed-interval schedule mode (ported from cloudcli-timer-agent):
 *   1. interval primitives: isIntervalRule / isSchedulable / scheduleNextMs /
 *      intervalNextMs (gap stacking, no drift across restarts)
 *   2. withSchedule interval patches (mode switch semantics, cron cleared)
 *   3. persisted-ledger repair: interval rows survive parseLedger
 *   4. the persisted-nextRunAt model: one-shot rules (isOneShotRule,
 *      schedulability via a bare nextRunAt), resumeNextMs (real-execution
 *      base, missed slots skipped to the future), and settleExecution's
 *      auto-archive for consumed one-shots
 */
import { intervalNextMs, isIntervalRule, isOneShotRule, isSchedulable, isValidCron, nextRunAtMs, resumeNextMs, scheduleNextMs } from '../src/core/schedule.ts'
import { settleExecution, startExecution, withSchedule, type JobRecord } from '../src/core/jobs.ts'
import { InMemoryJobStore, parseLedger } from '../src/core/store.ts'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}
function section(name: string): void { console.log(`\n== ${name}`) }

const MIN = 60_000

// ============================================================================
// 1. interval primitives
// ============================================================================
section('primitives: mode detection + next-run math')
check('isIntervalRule: only a positive intervalMinutes counts',
  isIntervalRule({ intervalMinutes: 302 }) && !isIntervalRule({ intervalMinutes: 0 })
    && !isIntervalRule({ cron: '0 9 * * *' }) && !isIntervalRule(undefined) && !isIntervalRule(null))
check('isSchedulable: cron or interval, not neither',
  isSchedulable({ cron: '0 9 * * *' }) && isSchedulable({ cron: '', intervalMinutes: 5 })
    && !isSchedulable({ cron: '' }) && !isSchedulable(undefined))
check('isValidCron still rejects junk (cron grammar untouched)',
  !isValidCron('0 9 * *') && isValidCron('0 9 * * *'))

const from = Date.UTC(2026, 8, 5, 12, 0, 0)
check('scheduleNextMs: interval adds exactly N minutes from the base',
  scheduleNextMs({ cron: '', intervalMinutes: 302 }, from) === from + 302 * MIN)
check('scheduleNextMs: cron delegates to the grid',
  scheduleNextMs({ cron: '0 9 * * *' }, from) === nextRunAtMs('0 9 * * *', from))
check('intervalNextMs: without an anchor the first slot is from + N',
  intervalNextMs(undefined, 30, from) === from + 30 * MIN)
check('intervalNextMs: a future anchor slots at anchor + N',
  intervalNextMs(from + 10 * MIN, 30, from) === from + 40 * MIN)
check('intervalNextMs: a missed stretch stacks whole intervals (no drift)',
  // anchor 12:00, 90-min interval, resume at 14:10 → next slots 15:00, not 14:10+90.
  intervalNextMs(from, 90, from + 130 * MIN) === from + 180 * MIN)
check('intervalNextMs: the slot is strictly after from',
  intervalNextMs(from, 30, from + 30 * MIN) === from + 60 * MIN)

// ============================================================================
// 2. withSchedule interval patches
// ============================================================================
section('withSchedule: mode switch semantics')
function fixtureJob(): JobRecord {
  return {
    id: 'j1', title: 'j', description: '', prompt: 'p', status: 'idle',
    target: { workdir: '', sessionId: '' },
    createdAt: 1_000, updatedAt: 1_000, executions: [],
    schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 5_000, lastTriggeredAt: undefined },
  }
}

{
  const job = withSchedule(fixtureJob(), { intervalMinutes: 302 }, 2_000)
  check('setting intervalMinutes > 0 clears cron (interval mode wins)',
    job.schedule?.intervalMinutes === 302 && job.schedule?.cron === '' && job.schedule?.enabled === true)
  const back = withSchedule(job, { cron: '*/10 * * * *', intervalMinutes: 0 }, 3_000)
  check('cron + intervalMinutes: 0 switches back to cron mode',
    back.schedule?.cron === '*/10 * * * *' && back.schedule?.intervalMinutes === undefined)
  const cleared = withSchedule(job, { intervalMinutes: undefined }, 3_000)
  check('explicit undefined intervalMinutes clears interval mode, keeps cron field',
    cleared.schedule?.intervalMinutes === undefined && cleared.schedule?.cron === '')
  const kept = withSchedule(fixtureJob(), { enabled: false }, 3_000)
  check('patches without intervalMinutes keep an existing interval',
    withSchedule(withSchedule(kept, { intervalMinutes: 45 }, 4_000), { enabled: true }, 5_000)
      .schedule?.intervalMinutes === 45)
}

// ============================================================================
// 3. persisted-ledger repair
// ============================================================================
section('parseLedger: interval rows survive the repair pass')
{
  const store = new InMemoryJobStore()
  const row = {
    id: 'j-int', title: 'interval job', description: '', prompt: 'p',
    status: 'idle', target: { workdir: '', sessionId: '' },
    createdAt: 1_000, updatedAt: 1_000, executions: [],
    schedule: { enabled: true, cron: '', intervalMinutes: 302, nextRunAt: 9_000, lastTriggeredAt: 8_000 },
  }
  const jobs = parseLedger(JSON.stringify([row]))
  check('interval row kept with intervalMinutes + blank cron',
    jobs.length === 1 && jobs[0]?.schedule?.intervalMinutes === 302 && jobs[0]?.schedule?.cron === '')
  check('interval row keeps its grid bookkeeping',
    jobs[0]?.schedule?.enabled === true && jobs[0]?.schedule?.nextRunAt === 9_000)
  const broken = parseLedger(JSON.stringify([{ ...row, schedule: { enabled: true, cron: '', intervalMinutes: 0 } }]))
  check('an interval of 0 (neither cron nor interval) is dropped',
    broken.length === 1 && broken[0]?.schedule === undefined)
  // Round-trip through the store seam (save/load is a JSON round-trip too).
  store.save(jobs)
  check('InMemoryJobStore round-trips the interval rule',
    store.load()[0]?.schedule?.intervalMinutes === 302)
}

section('parseLedger: one-shot rows survive the repair pass')
{
  const row = {
    id: 'j-once', title: 'once job', description: '', prompt: 'p',
    status: 'idle', target: { workdir: '', sessionId: '' },
    createdAt: 1_000, updatedAt: 1_000, executions: [],
    schedule: { enabled: true, cron: '', nextRunAt: 9_000 },
  }
  const jobs = parseLedger(JSON.stringify([row]))
  check('one-shot row kept: blank cron, no interval, nextRunAt is the evidence',
    jobs.length === 1 && jobs[0]?.schedule?.nextRunAt === 9_000 && jobs[0]?.schedule?.enabled === true)
  const consumed = parseLedger(JSON.stringify([{
    ...row, schedule: { enabled: true, cron: '', nextRunAt: undefined, lastTriggeredAt: 8_000 },
  }]))
  check('consumed one-shot (lastTriggeredAt evidence) kept, disarmed',
    consumed.length === 1 && consumed[0]?.schedule !== undefined
    && consumed[0]?.schedule?.nextRunAt === undefined && consumed[0]?.schedule?.enabled === false)
  const blank = parseLedger(JSON.stringify([{
    ...row, schedule: { enabled: true, cron: '' },
  }]))
  check('a legacy blank rule (no evidence) is still dropped',
    blank.length === 1 && blank[0]?.schedule === undefined)
}

// ============================================================================
// 4. persisted-nextRunAt model: one-shot rules + resume math + auto-archive
// ============================================================================
section('one-shot detection + schedulability via a bare nextRunAt')
{
  // 一次性 = 无任何循环表达式,nextRunAt 是唯一调度依据。
  check('isSchedulable: blank cron + no interval + a nextRunAt is schedulable (one-shot)',
    isSchedulable({ cron: '', nextRunAt: 5_000 }))
  check('isSchedulable: blank cron + no interval + no nextRunAt is not',
    !isSchedulable({ cron: '' }) && !isSchedulable({}) && !isSchedulable(undefined) && !isSchedulable(null))
  check('isOneShotRule: blank cron, no interval — nextRunAt presence is irrelevant',
    isOneShotRule({ cron: '' }) && isOneShotRule({}) && isOneShotRule(undefined)
      && isOneShotRule({ cron: '', nextRunAt: 5_000 }))
  check('isOneShotRule: a cron expression or an interval is not one-shot',
    !isOneShotRule({ cron: '0 9 * * *' }) && !isOneShotRule({ cron: '', intervalMinutes: 302 }))
}

section('resumeNextMs: real-execution base, missed slots skipped to the future')
{
  // nextRunAtMs works in local time, so build the fixtures locally too.
  const today9 = new Date(2026, 8, 5, 9, 0, 0, 0).getTime()
  const yesterday9 = today9 - 24 * 60 * 60 * 1000
  const tomorrow9 = today9 + 24 * 60 * 60 * 1000
  const cronRule = { cron: '0 9 * * *' }
  // a) base(昨天 9:00)的下一个槽位是今天 9:00,已过期 → 跳过,取明天 9:00。
  check('cron resume: a slot missed while paused is skipped, next is tomorrow',
    resumeNextMs(cronRule, yesterday9, today9 + 60 * MIN) === tomorrow9)
  // b) base(今天 8:00)的下一个槽位(今天 9:00)仍在未来 → 正常取它。
  check('cron resume: a still-future base slot is taken as-is',
    resumeNextMs(cronRule, today9 - 60 * MIN, today9 - 30 * MIN) === today9)
  // c) interval 网格从锚点堆叠整周期,严格未来,不漂移。
  const anchor = Date.UTC(2026, 8, 5, 12, 0, 0)
  check('interval resume: whole cycles stacked from the anchor, strictly future',
    resumeNextMs({ cron: '', intervalMinutes: 302 }, anchor, anchor + 500 * MIN)
      === anchor + 604 * MIN)
  check('interval resume: without a base the first slot is now + N',
    resumeNextMs({ cron: '', intervalMinutes: 302 }, undefined, anchor) === anchor + 302 * MIN)
  // d) 一次性原样返回 nextRunAt,即使是过去的时间(调用方决定去留)。
  const past = anchor - 7 * MIN
  check('one-shot resume: nextRunAt passes through untouched, even in the past',
    resumeNextMs({ cron: '', nextRunAt: past }, anchor, anchor) === past)
}

section('settleExecution: a consumed one-shot archives automatically')
{
  function oneShotJob(): JobRecord {
    return {
      id: 'j-once', title: 'once', description: '', prompt: 'p', status: 'idle',
      target: { workdir: '', sessionId: '' },
      createdAt: 1_000, updatedAt: 1_000, executions: [],
      schedule: { enabled: true, cron: '', nextRunAt: 9_000, lastTriggeredAt: undefined },
    }
  }
  const started = startExecution(oneShotJob(), 2_000, 'e1', 'new-session')
  check('settle: a succeeded one-shot lands in archived, not done',
    settleExecution(started.job, 'e1', 'succeeded', 3_000, undefined).status === 'archived')
  const failedStart = startExecution(oneShotJob(), 2_000, 'e2', 'new-session')
  check('settle: a failed one-shot archives too (the shot is consumed either way)',
    settleExecution(failedStart.job, 'e2', 'failed', 3_000, 'boom').status === 'archived')
  const cancelledStart = startExecution(oneShotJob(), 2_000, 'e3', 'new-session')
  check('settle: a cancelled one-shot is NOT archived (shot not consumed)',
    settleExecution(cancelledStart.job, 'e3', 'cancelled', 3_000, undefined).status === 'idle')
  // 对照组:循环任务照旧落入 done/failed。
  const recurring = { ...oneShotJob(), id: 'j-cron', schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 9_000, lastTriggeredAt: undefined } }
  const recurringStart = startExecution(recurring, 2_000, 'e4', 'new-session')
  check('settle: a recurring (cron) job still settles into done',
    settleExecution(recurringStart.job, 'e4', 'succeeded', 3_000, undefined).status === 'done')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
