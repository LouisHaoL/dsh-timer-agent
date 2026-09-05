/**
 * Minimal 5-field cron parsing and next-run computation for scheduled job
 * runs. Framework-free and dependency-free so the scheduler and controller
 * share one tiny pure module. (Same grammar as the task-board / standard
 * cron: 分 时 日 月 周, wildcard / step / range / comma lists, day+weekday
 * restricted fields combine with OR semantics.)
 */

/** The parsed match sets of one cron expression. */
export interface CronSchedule {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  /** Weekdays 0-6, 0 = Sunday (input 7 normalized to 0). */
  weekdays: ReadonlySet<number>
  /** Whether the day-of-month field was the literal '*' (unrestricted). */
  dayWildcard: boolean
  /** Whether the weekday field was the literal '*' (unrestricted). */
  weekdayWildcard: boolean
}

/** Inclusive ranges per field, in cron order. */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minutes
  [0, 23], // hours
  [1, 31], // days
  [1, 12], // months
  [0, 7], // weekdays (7 = Sunday, normalized below)
]

/**
 * Parse a 5-field cron expression.
 * @returns the match sets, or null when the expression is invalid.
 */
export function parseCron(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets: Set<number>[] = []
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index]
    const set = new Set<number>()
    if (!parseField(fields[index], min, max, set)) return null
    sets.push(set)
  }
  const weekdays = new Set<number>()
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day)
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*',
  }
}

/** Whether the expression parses. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/**
 * Whether the rule runs on a fixed interval ("every N minutes from the last
 * trigger") instead of a cron grid — cron cannot express e.g. every 302
 * minutes, and manual runs need to re-anchor a live grid.
 */
export function isIntervalRule(
  rule: { cron?: string; intervalMinutes?: number } | undefined | null,
): boolean {
  return rule !== null && rule !== undefined &&
    typeof rule.intervalMinutes === 'number' && rule.intervalMinutes > 0
}

/**
 * Whether an enabled rule can fire at all: a cron expression, a fixed
 * interval, or an explicit `nextRunAt` (the one-shot shape — no recurrence
 * expression, the persisted instant is the whole schedule). The existing
 * "no cron + no interval" shape still returns false so legacy blank rules
 * stay unschedulable.
 */
export function isSchedulable(
  rule: { cron?: string; intervalMinutes?: number; nextRunAt?: number } | undefined | null,
): boolean {
  return rule !== null && rule !== undefined &&
    ((rule.cron ?? '') !== '' || isIntervalRule(rule) || rule.nextRunAt !== undefined)
}

/**
 * Whether the rule has no recurrence expression at all (blank cron, no
 * interval) — i.e. it is a one-shot: the persisted `nextRunAt` is its only
 * scheduling basis and it is consumed by the next execution, however that
 * execution ends. Whether `nextRunAt` is actually set does not matter here;
 * callers decide how to treat a one-shot without one.
 */
export function isOneShotRule(rule: { cron?: string; intervalMinutes?: number } | undefined | null): boolean {
  return !isIntervalRule(rule) && (rule?.cron ?? '') === ''
}

/**
 * Next due instant when a paused/missed rule resumes, anchored on the REAL
 * last execution: `baseMs` is the latest execution's startedAt (callers fall
 * back to lastTriggeredAt / createdAt before calling). Missed slots are NOT
 * replayed — the result is always strictly in the future relative to `nowMs`
 * (except a one-shot, which is passed through untouched: the caller owns the
 * keep-or-skip decision for a past one-shot instant).
 *
 * - interval: grid math via {@link intervalNextMs} (whole-interval stacking,
 *   no drift; a missing base degenerates to `nowMs + N`).
 * - cron: normally the next grid match after `baseMs`; when that lies in the
 *   past (or the expression fails to parse), it skips ahead to the next match
 *   after `nowMs`.
 * - one-shot: `rule.nextRunAt` verbatim (possibly in the past).
 *
 * @returns undefined only when the cron expression is invalid on both probes.
 */
export function resumeNextMs(
  rule: { cron: string; intervalMinutes?: number; nextRunAt?: number },
  baseMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (isIntervalRule(rule)) return intervalNextMs(baseMs, rule.intervalMinutes!, nowMs)
  if (isOneShotRule(rule)) return rule.nextRunAt
  const fromBase = nextRunAtMs(rule.cron, baseMs ?? nowMs)
  if (fromBase !== undefined && fromBase > nowMs) return fromBase
  // The base's next slot already passed (host down / paused too long): skip
  // the missed occurrence, take the next one strictly after now.
  return nextRunAtMs(rule.cron, nowMs)
}

/** Next run for the rule: interval → `fromMs + N minutes`; cron → next grid match. */
export function scheduleNextMs(
  rule: { cron: string; intervalMinutes?: number },
  fromMs: number,
): number | undefined {
  if (isIntervalRule(rule)) return fromMs + rule.intervalMinutes! * 60_000
  return nextRunAtMs(rule.cron, fromMs)
}

/**
 * Next fixed-interval instant anchored on the last trigger: `anchorMs` plus
 * the smallest whole number of intervals landing strictly after `fromMs`.
 * A missed stretch (host down, job paused, long run) stacks whole intervals
 * forward instead of re-anchoring at the current time, so the grid never
 * drifts with restarts; without an anchor the first slot is `fromMs + N`.
 */
export function intervalNextMs(
  anchorMs: number | undefined,
  intervalMinutes: number,
  fromMs: number,
): number {
  const step = intervalMinutes * 60_000
  let next = (anchorMs ?? fromMs) + step
  if (next <= fromMs) next += Math.ceil((fromMs - next) / step) * step
  // fromMs landing exactly on a grid point gets one more step: the slot is
  // strictly after it (the ported original returned fromMs itself there).
  if (next <= fromMs) next += step
  return next
}

/**
 * Compute the next matching instant after `fromMs` (ms epoch), in local
 * time, at minute granularity, strictly greater than `fromMs`.
 */
export function nextRunAtMs(expr: string, fromMs: number): number | undefined {
  const schedule = parseCron(expr)
  if (schedule === null) return undefined
  const from = new Date(fromMs)
  const scan = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0)
  const limitMs = fromMs + 366 * 24 * 60 * 60 * 1000
  while (scan.getTime() <= limitMs) {
    if (matches(schedule, scan)) return scan.getTime()
    scan.setMinutes(scan.getMinutes() + 1)
  }
  return undefined
}

/** Parse one comma-list field into the match set. */
function parseField(field: string, min: number, max: number, out: Set<number>): boolean {
  if (field === '*') {
    for (let value = min; value <= max; value++) out.add(value)
    return true
  }
  for (const part of field.split(',')) {
    if (part === '') return false
    const [range, stepRaw] = part.split('/')
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      if (a === '' || b === '' || !isDigits(a) || !isDigits(b)) return false
      low = Number(a)
      high = Number(b)
    } else if (isDigits(range)) {
      low = Number(range)
      high = Number(range)
    } else {
      return false
    }
    if (low < min || high > max || low > high) return false
    const step = stepRaw === undefined ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN
    if (!Number.isInteger(step) || step < 1) return false
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return true
}

/** Day/weekday OR semantics: a restricted day field alone gates, and vice versa. */
function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minutes.has(date.getMinutes())) return false
  if (!schedule.hours.has(date.getHours())) return false
  if (!schedule.months.has(date.getMonth() + 1)) return false
  const dayMatches = schedule.days.has(date.getDate())
  const weekdayMatches = schedule.weekdays.has(date.getDay())
  if (schedule.dayWildcard) return weekdayMatches
  if (schedule.weekdayWildcard) return dayMatches
  return dayMatches || weekdayMatches
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}
