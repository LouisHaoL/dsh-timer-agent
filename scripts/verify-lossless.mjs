// Verify timer_agent list output passes lossless-JSON validation:
// a value is lossless iff JSON.parse(JSON.stringify(v)) deep-equals v
// AND no property anywhere holds an explicit `undefined`.
import { registerTimerTool } from '../src/host/tools.ts'
import { createJob, withSchedule } from '../src/core/jobs.ts'

function hasUndefinedValue(v, path = '$') {
  if (v === undefined) return `${path} is undefined`
  if (v === null || typeof v !== 'object') return null
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = hasUndefinedValue(v[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) return `${path}.${k} is undefined`
    const hit = hasUndefinedValue(val, `${path}.${k}`)
    if (hit) return hit
  }
  return null
}

function isLossless(v) {
  const hit = hasUndefinedValue(v)
  if (hit) return hit
  try {
    if (JSON.stringify(JSON.parse(JSON.stringify(v))) !== JSON.stringify(v)) return 'not stable'
    return null
  } catch (e) {
    return `unserializable: ${e.message}`
  }
}

// --- fake deps ---
const jobs = []
const store = {
  load: async () => jobs,
  mutate: async fn => fn(jobs).result,
}
const runner = { requestRun: async () => true }
const tool = registerTimerTool({ register: def => def }, { store, runner, now: () => Date.now() })

// agent job with an in-flight execution (sessionId undefined, result undefined, exitCode absent)
const agentJob = createJob({
  title: 'agent job', description: '', prompt: 'do things',
  target: { workdir: 'D:\\workspace\\dsh', sessionId: '' },
}, Date.now(), 'job-agent-1')
const scheduled = withSchedule(agentJob, { enabled: true, cron: '0 9 * * *', nextRunAt: undefined }, Date.now())

// command job, paused (schedule enabled but no nextRunAt), with finished execution
const cmdJob = {
  ...createJob({
    title: 'cmd job', description: '', prompt: '',
    kind: 'command', command: 'pwsh', args: '-Command "echo hi"',
    target: { workdir: '', sessionId: '' },
  }, Date.now(), 'job-cmd-1'),
  timeoutMs: 300000,
  executions: [{ startedAt: Date.now() - 60000, result: 'failed', sessionId: undefined, exitCode: 1 }],
}
jobs.push(scheduled, cmdJob)

const out = await tool.execute({ action: 'list' })
const bad = isLossless(out)
if (bad) {
  console.error('FAIL:', bad)
  process.exit(1)
}
console.log('list output is lossless JSON ✓')
console.log(JSON.stringify(out, null, 2))
