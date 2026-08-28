/**
 * Command-execution helpers for 'command' jobs (普通任务): quote-aware
 * argument splitting and output tail truncation. Framework-free so both the
 * host runner and the tests import it directly.
 *
 * @module dsh-timer-agent/command
 */

/**
 * Split an argument string the way a shell roughly would:
 * - whitespace separates arguments (repeated whitespace collapses)
 * - double quotes group (backslash escapes `\` and `"` inside)
 * - single quotes group literally (no escapes inside)
 *
 * Unlike a full shell there is no variable expansion or redirection — the
 * string is pure argv for the spawned executable.
 */
export function splitCommandArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let hasCurrent = false
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasCurrent) {
        args.push(current)
        current = ''
        hasCurrent = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      hasCurrent = true
      index += 1
      let closed = false
      while (index < input.length) {
        const inner = input[index]
        if (inner === '\\' && index + 1 < input.length && (input[index + 1] === '"' || input[index + 1] === '\\')) {
          current += input[index + 1]
          index += 2
          continue
        }
        if (inner === '"') {
          closed = true
          index += 1
          break
        }
        current += inner
        index += 1
      }
      if (!closed) throw new Error(`unterminated double quote in args: ${input}`)
      continue
    }
    if (char === "'") {
      hasCurrent = true
      index += 1
      const close = input.indexOf("'", index)
      if (close === -1) throw new Error(`unterminated single quote in args: ${input}`)
      current += input.slice(index, close)
      index = close + 1
      continue
    }
    hasCurrent = true
    current += char
    index += 1
  }
  if (hasCurrent) args.push(current)
  return args
}

/** Hard cap on captured output kept in memory per stream (bytes-ish). */
const CAPTURE_CAP = 128 * 1024

/** What a settled command execution keeps in the ledger. */
export const OUTPUT_TAIL_CHARS = 16_000

/**
 * Keep the tail of a captured output blob (the interesting part of a long
 * script log is almost always the end), with an elision marker when trimmed.
 */
export function truncateOutputTail(text: string, maxChars = OUTPUT_TAIL_CHARS): string {
  if (text.length <= maxChars) return text
  const elided = text.length - maxChars
  return `…（前 ${elided} 字符已省略）\n${text.slice(-maxChars)}`
}

/** Append a chunk to a capped capture buffer (keeps head + tail marker). */
export function appendCapped(buffer: string, chunk: string): string {
  if (buffer.length >= CAPTURE_CAP) {
    // Already capped: keep sliding the tail so recent output stays visible.
    return buffer.slice(chunk.length) + chunk
  }
  const next = buffer + chunk
  if (next.length <= CAPTURE_CAP) return next
  return `…（输出超长，仅保留末尾）\n${next.slice(-CAPTURE_CAP)}`
}
