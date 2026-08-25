/**
 * E2E probe: reproduce the 查看会话 jump bug.
 * Drives the real GUI at 127.0.0.1:3080 via headless Edge + CDP.
 * Steps: open board -> open the first job card -> click 查看会话 ->
 * read the persisted current-session selection + console warnings.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const URL = 'http://127.0.0.1:3080'

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:\\workspace\\dsh\\hermes-agent-research\\dsh-timer-agent\\.tmp-edge-profile',
  '--no-first-run', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })

const cdp = { id: 0, pending: new Map(), ws: undefined, events: [] }

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdp.id
    cdp.pending.set(id, { resolve, reject })
    cdp.ws.send(JSON.stringify({ id, method, params }))
  })
}

const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`)
  return r.result.value
}

try {
  // wait for the debug endpoint
  let targets
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await res.json()
      if (targets.length) break
    } catch { /* retry */ }
  }
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  cdp.ws = ws
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    if (data.id !== undefined && cdp.pending.has(data.id)) {
      const { resolve, reject } = cdp.pending.get(data.id)
      cdp.pending.delete(data.id)
      data.error ? reject(new Error(data.error.message)) : resolve(data.result)
    } else if (data.method) {
      cdp.events.push(data)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: URL })
  await sleep(6000) // let the GUI boot

  const boot = await evaluate(`({
    entry: !!document.querySelector('[data-dsh-timeragent-entry]'),
    sidebarText: document.querySelector('[data-pane="sidebar"]')?.innerText?.slice(0, 200) ?? null,
  })`)
  console.log('BOOT:', JSON.stringify(boot))

  // open the timer board
  await evaluate(`document.querySelector('[data-dsh-timeragent-entry]')?.click(); true`)
  await sleep(1200)
  const board = await evaluate(`({
    active: document.documentElement.hasAttribute('data-dsh-timeragent-active'),
    cards: [...document.querySelectorAll('[data-dsh-timeragent-board] button')].filter(b => b.className.toString().includes('jobCard')).length,
  })`)
  console.log('BOARD:', JSON.stringify(board))

  // click the first non-archived job card (the done one)
  const opened = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-timeragent-board] button')]
      .filter(b => b.className.toString().includes('jobCard') && b.getAttribute('data-status') !== 'archived')
    if (cards.length === 0) return 'no cards'
    cards[0].click()
    return cards[0].innerText.slice(0, 80)
  })()`)
  console.log('CARD OPENED:', JSON.stringify(opened))
  await sleep(800)

  const detail = await evaluate(`({
    hasDetail: !!document.querySelector('[role="dialog"]'),
    sessionButtons: [...document.querySelectorAll('[role="dialog"] button')]
      .filter(b => b.textContent.includes('⌁')).map(b => ({ text: b.textContent, title: b.title })),
  })`)
  console.log('DETAIL:', JSON.stringify(detail))

  // remember current selection BEFORE the jump
  const before = await evaluate(`localStorage.getItem('dsh.sessions.current')`)

  // click 查看会话
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes('⌁'))
    if (!btn) return 'no session button'
    btn.click()
    return btn.title
  })()`)
  console.log('CLICKED SESSION BTN, target id =', JSON.stringify(clicked))
  await sleep(3500)

  const after = await evaluate(`localStorage.getItem('dsh.sessions.current')`)
  const boardStill = await evaluate(`({
    boardActive: document.documentElement.hasAttribute('data-dsh-timeragent-active'),
    conversationVisible: !!document.querySelector('[data-pane="conversation"]'),
    headerText: document.querySelector('[data-pane="conversation"]')?.innerText?.slice(0, 120) ?? null,
  })`)
  console.log('SELECTION before =', before)
  console.log('SELECTION after  =', after)
  console.log('AFTER:', JSON.stringify(boardStill))

  // console warnings from the plugin
  const warns = cdp.events
    .filter(e => e.method === 'Runtime.consoleAPICalled'
      && JSON.stringify(e.params.args ?? '').includes('dsh-timer-agent'))
    .map(e => e.params.args.map(a => a.value).join(' '))
  console.log('PLUGIN CONSOLE:', JSON.stringify(warns, null, 1))
} finally {
  edge.kill()
}
