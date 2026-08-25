/** Screenshot probe: open the timer board + job detail, save PNGs. */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9335
const URL = 'http://127.0.0.1:3080'
const OUT = 'D:\\workspace\\dsh\\hermes-agent-research\\dsh-timer-agent\\.tmp-shots'

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}\\profile`,
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
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`)
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
  await evaluate(`document.querySelector('[data-dsh-timeragent-entry]')?.click(); true`)
  await sleep(1500)
  // find overflow elements in the board
  const overflow = await evaluate(`(() => {
    const board = document.querySelector('[data-dsh-timeragent-view]')
    if (!board) return 'no board'
    const bad = []
    for (const el of board.querySelectorAll('*')) {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        bad.push({ cls: (el.className.toString() || el.tagName).slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent || '').slice(0, 40) })
      }
    }
    return bad.slice(0, 20)
  })()`)
  console.log('OVERFLOW:', JSON.stringify(overflow, null, 1))
  let shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}\\board.png`, Buffer.from(shot.data, 'base64'))
  console.log('board.png saved')

  // open the card grid's cards and check each card's inner geometry
  const cardsInfo = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-timeragent-board] button')].filter(b => b.className.toString().includes('jobCard'))
    return cards.map(c => ({ status: c.getAttribute('data-status'), sw: c.scrollWidth, cw: c.clientWidth, sh: c.scrollHeight, ch: c.clientHeight, title: c.querySelector('[class*=cardTitle]')?.textContent?.slice(0, 30) }))
  })()`)
  console.log('CARDS:', JSON.stringify(cardsInfo, null, 1))
  // open the SenseNova card (giant prompt) and check detail overflow
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-timeragent-board] button')].filter(b => b.className.toString().includes('jobCard'))
    const target = cards.find(c => c.textContent.includes('SenseNova')) ?? cards.find(c => c.getAttribute('data-status') !== 'archived')
    target?.click(); return true
  })()`)
  await sleep(900)
  const detailOverflow = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    if (!dlg) return 'no dialog'
    const bad = []
    for (const el of [dlg, ...dlg.querySelectorAll('*')]) {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push({ cls: (el.className.toString() || el.tagName).slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent || '').slice(0, 30) })
      if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && !['auto','scroll'].includes(getComputedStyle(el).overflowY)) bad.push({ cls: 'V:' + (el.className.toString() || el.tagName).slice(0, 50), sh: el.scrollHeight, ch: el.clientHeight })
    }
    return { title: dlg.querySelector('h2')?.textContent, bad: bad.slice(0, 25) }
  })()`)
  console.log('DETAIL OVERFLOW:', JSON.stringify(detailOverflow, null, 1))
  shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}\\detail.png`, Buffer.from(shot.data, 'base64'))
  console.log('detail.png saved')
} finally {
  edge.kill()
}
