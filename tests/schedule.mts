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
 */
import { intervalNextMs, isIntervalRule, isSchedulable, isValidCron, nextRunAtMs, scheduleNextMs } from '../src/core/schedule.ts'
import { withSchedule, type JobRecord } from '../src/core/jobs.ts'
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
