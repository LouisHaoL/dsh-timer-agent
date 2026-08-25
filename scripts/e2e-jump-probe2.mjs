/**
 * Instrumented probe: patch console.warn/error, record everything around the
 * 查看会话 click, and report what actually happened.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9334
const URL = 'http://127.0.0.1:3080'

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:\\workspace\\dsh\\hermes-agent-research\\dsh-timer-agent\\.tmp-edge-profile2',
  '--no-first-run', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })

const cdp = { id: 0, pending: new Map(), ws: undefined }
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdp.id
    cdp.pending.set(id, { resolve, reject })
    cdp.ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 800)}`)
  return r.result.value
}

try {
  let targets
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (targets.length) break
    } catch { /* retry */ }
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  cdp.ws = ws
  ws.onmessage = (msg) => {
    const d = JSON.parse(msg.data)
    if (d.id !== undefined && cdp.pending.has(d.id)) {
      const { resolve, reject } = cdp.pending.get(d.id)
      cdp.pending.delete(d.id)
      d.error ? reject(new Error(d.error.message)) : resolve(d.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: URL })
  await sleep(6000)

  // instrument
  await evaluate(`(() => {
    window.__log = []
    for (const level of ['warn', 'error', 'log']) {
      const orig = console[level].bind(console)
      console[level] = (...args) => { window.__log.push(level + ': ' + args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) } }).join(' ')); orig(...args) }
    }
    window.addEventListener('error', e => window.__log.push('uncaught: ' + e.message + ' || STACK: ' + (e.error?.stack ?? '').slice(0, 1500)))
    window.addEventListener('unhandledrejection', e => window.__log.push('rejection: ' + String(e.reason)))
    return true
  })()`)

  await evaluate(`document.querySelector('[data-dsh-timeragent-entry]')?.click(); true`)
  await sleep(1000)
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-timeragent-board] button')]
      .filter(b => b.className.toString().includes('jobCard') && b.getAttribute('data-status') !== 'archived')
    cards[0]?.click(); return true
  })()`)
  await sleep(700)
  const before = await evaluate(`localStorage.getItem('dsh.sessions.current')`)
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes('⌁'))
    btn?.click(); return true
  })()`)
  await sleep(4000)

  const after = await evaluate(`localStorage.getItem('dsh.sessions.current')`)
  const log = await evaluate(`window.__log`)
  console.log('before =', before)
  console.log('after  =', after)
  console.log('LOG:', JSON.stringify(log, null, 1).slice(0, 4000))
} finally {
  edge.kill()
}
