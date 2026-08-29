/**
 * README screenshot probe: open the New Job modal on a live instance,
 * MASK all real data in the DOM (project names, session titles, username),
 * then capture a cropped PNG of just the modal → docs/screenshot.png.
 *
 * Usage: node scripts/shot-readme.mjs [port]
 * Requires a dsh web instance serving the new lib on the given port.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, copyFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = process.argv[2] ?? '13140'
const URL = `http://127.0.0.1:${PORT}`
const OUT = 'docs/screenshot.png'
const TMP = '.tmp-shots/readme-newjob.png'

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=9336',
  '--user-data-dir=.tmp-shots\\readme-profile',
  '--no-first-run', '--window-size=1440,1080', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' })

const cdp = { id: 0, pending: new Map(), ws: undefined }
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdp.id
    cdp.pending.set(id, { resolve, reject })
    cdp.ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`)
  return r.result.value
}

try {
  let targets
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      targets = await (await fetch('http://127.0.0.1:9336/json/list')).json()
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
  await sleep(7000)

  // 1. open the timer board
  await evaluate(`document.querySelector('[data-dsh-timeragent-entry]')?.click(); true`)
  await sleep(1500)

  // 2. open the New Job modal
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[data-dsh-timeragent-board] button')]
      .find(b => /新建|New Job/.test(b.textContent ?? ''))
    btn?.click()
    return !!btn
  })()`)
  if (!opened) throw new Error('new-job button not found')
  await sleep(1200)

  // 3. demo title — filled LAST (before masking) so later re-renders
  //    (tree clicks / cron toggle) cannot reset it.
  await evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input[aria-label]')
    if (!input) return false
    return true
  })()`)
  await sleep(300)

  // 4. expand at most the first 3 target groups (tree stays compact)
  await evaluate(`(() => {
    const headers = [...document.querySelectorAll('[role="dialog"] button')]
      .filter(b => /targetGroupHeader/.test(b.className.toString()))
    for (const h of headers.slice(0, 3)) h.click()
    return headers.length
  })()`)
  await sleep(600)

  // 5. arm the cron section so the presets row shows
  await evaluate(`(() => {
    const box = document.querySelector('[role="dialog"] input[type="checkbox"]')
    if (box && !box.checked) box.click()
    return true
  })()`)
  await sleep(500)

  // 5.5 demo title (React-controlled input: native setter + input event;
  //     located via its field label — the input itself carries no aria-label)
  const titled = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const field = [...dialog.querySelectorAll('label')]
      .find(l => /^\\s*(标题|Title)\\s*$/.test(l.querySelector('[class*="fieldLabel"]')?.textContent ?? 'x'))
    const input = field?.querySelector('input')
    if (!input) return 'no title input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '每周五 17:00 生成项目周报')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  console.log('TITLE:', JSON.stringify(titled))
  await sleep(300)

  // 6. MASK real data inside the dialog (pure DOM text swap; no re-render
  //    follows because nothing dispatches React events afterwards).
  const masked = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return { error: 'no dialog' }
    const projNames = ['运营中台', '数据管道', '文档助手', '实验沙盒', '旧项目归档']
    const sessNames = ['周报整理', '接口联调排查', '需求评审纪要', '日志分析', '部署脚本', '竞品调研', '周会安排', '数据导出']
    let proj = 0
    let sess = 0
    // project group headers → generic project names
    for (const el of dialog.querySelectorAll('[class*="targetGroupName"]')) {
      if (proj < projNames.length && el.textContent && !/默认/.test(el.textContent)) el.textContent = projNames[proj++]
    }
    // pinned-session row labels → generic session titles (fixed UI labels untouched)
    for (const el of dialog.querySelectorAll('button [class*="targetRowLabel"]')) {
      const row = el.closest('button')
      if (!row) continue
      if (/新建|new session/i.test(row.textContent ?? '')) continue
      if (sess < sessNames.length) el.textContent = sessNames[sess++]
    }
    // username / home-path leakage anywhere in the dialog text
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) !== null) {
      if (node.nodeValue && /Louis/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replaceAll(/Louis/gi, 'demo')
    }
    return { groups: proj, sessions: sess }
  })()`)
  console.log('MASKED:', JSON.stringify(masked))
  await sleep(400)

  // 7. crop-capture the modal (+ dimmed margin so it reads as a modal)
  const box = await evaluate(`(() => {
    const el = document.querySelector('[role="dialog"]')
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  const pad = 26
  const clip = {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
    width: Math.min(1440, box.width + pad * 2), height: Math.min(1080, box.height + pad * 2),
    scale: 1,
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(TMP, Buffer.from(shot.data, 'base64'))
  copyFileSync(TMP, OUT)
  console.log(`saved ${OUT} (${box.width}x${box.height} modal, clip ${Math.round(clip.width)}x${Math.round(clip.height)})`)
} finally {
  edge.kill()
}
