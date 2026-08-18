/**
 * Post-build step: inline lib/style.css into lib/client.js as a
 * self-injecting <style> element.
 *
 * The dsh plugin loader serves the browser entry as one JS bundle; it does
 * not load sibling CSS assets, so the stylesheet generated from the CSS
 * module must ride inside the bundle itself. The injected classes are the
 * tsdown-hashed names (board_module_default in client.js already references
 * them); the raw rules are appended verbatim under a document.head <style>.
 *
 * The injector is inserted BEFORE the factory footer (inside the factory
 * closure), so it runs at materialization — not at script-execution time —
 * and the data-plugin/data-plugin-css attributes let the loader's HMR own
 * the tag (claim on materialize, remove on reload), mirroring the in-repo
 * preset's CSS module output.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Factory return statement from the tsdown.config.ts footer — the insertion
 * anchor. Rolldown re-prints the whole chunk (banner/footer included), so the
 * footer is not a stable literal; the return line is. The injector must land
 * BEFORE it: statements after the return never execute.
 */
const FACTORY_RETURN = 'return module.exports;'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const cssPath = join(here, '..', 'lib', 'style.css')

let css = ''
try {
  css = readFileSync(cssPath, 'utf8')
} catch {
  console.warn('[dsh-timer-agent] lib/style.css not found; skipping CSS inline')
  process.exit(0)
}
if (css.trim() === '') process.exit(0)

const injector = `
// #region inlined stylesheet (post-build: scripts/inline-css.mjs)
(function injectTimerAgentStyle() {
  if (typeof document === 'undefined') return;
  var tagId = 'dsh-timer-agent/board.module.css';
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
  var style = document.createElement('style');
  style.setAttribute('data-plugin', 'dsh-timer-agent');
  style.setAttribute('data-plugin-css', tagId);
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);
})();
// #endregion
`

const client = readFileSync(clientPath, 'utf8')
const returnAt = client.lastIndexOf(FACTORY_RETURN)
if (returnAt < 0) {
  throw new Error(
    '[dsh-timer-agent] factory return not found in lib/client.js — '
    + 'tsdown.config.ts and scripts/inline-css.mjs have drifted (the __ModuleLoader__ wrapper must stay)',
  )
}
const lineStart = client.lastIndexOf('\n', returnAt) + 1
writeFileSync(clientPath, client.slice(0, lineStart) + injector + client.slice(lineStart), 'utf8')
console.log(`[dsh-timer-agent] inlined ${css.length} bytes of CSS into lib/client.js (inside the factory)`)
