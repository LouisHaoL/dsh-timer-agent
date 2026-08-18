/**
 * Ad-hoc smoke test: execution targeting paths (pinned session, default
 * workspace new session, named workspace new session) with fake faces.
 * Run: node --experimental-transform-types tests/smoke-execution.mjs
 */
import { ExecutionService } from '../src/core/execution.ts'

function makeDriver(log: string[]) {
  let turnEnds = 0
  return {
    rename: async (title: string) => { log.push(`rename:${title}`) },
    prompt: async (content: readonly unknown[]) => {
      log.push(`prompt:${(content[0] as { text: string }).text}`)
      turnEnds += 1 // the accepted turn completes (real drivers grow turnEnds)
      return { ok: true as const }
    },
    getSnapshot: () => ({ running: false, lastAgentError: null, turnEnds: new Map(Array.from({ length: turnEnds }, (_, i) => [i, 1])) }),
    subscribe: (fn: () => void) => { fn(); return () => {} },
  }
}

function fakeJob(sessionId: string, workspaceId: string) {
  return { id: 'j', title: 'T', description: '', prompt: 'hello', status: 'idle' as const, target: { workspaceId, sessionId }, createdAt: 0, updatedAt: 0, executions: [] }
}

function fakeExec(id: string, targeting: 'new-session' | 'specified-session') {
  return { id, sessionId: undefined, targeting, startedAt: 0, endedAt: undefined, result: undefined, error: undefined }
}

const log: string[] = []
const driver = makeDriver(log)

// 1. pinned session — must NOT connect any workspace, must NOT rename
const pinned = new ExecutionService({
  sessions: {
    list: { getSnapshot: () => ({ phase: 'ready' as const, byId: { s1: { running: false } } }), subscribe: () => () => {} },
    binding: (id: string) => (id === 's1' ? { session: driver } : undefined),
  },
  workspaces: {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'wsA' }], recentWorkspaceId: 'ws9' }) },
    connectWorkspace: async () => { throw new Error('should not connect for a pinned session') },
  },
})
const events1: Array<{ kind: string; sessionId?: string; outcome?: string }> = []
await pinned.run(fakeJob('s1', ''), fakeExec('e1', 'specified-session'), (e) => { events1.push(e as never) })
console.log('pinned session prompts existing session:',
  log.includes('prompt:hello') && !log.some(entry => entry.startsWith('rename:'))
  && events1.some(e => e.kind === 'started' && e.sessionId === 's1')
  && events1.some(e => e.kind === 'settled' && e.outcome === 'succeeded'))

// 2. blank/blank — default workspace (most-recent ws9) new session
log.length = 0
const events2: Array<{ kind: string; sessionId?: string }> = []
const byDefault = new ExecutionService({
  sessions: {
    list: { getSnapshot: () => ({ phase: 'ready' as const, byId: { s2: { running: false } } }), subscribe: () => () => {} },
    binding: (id: string) => (id === 's2' ? { session: driver } : undefined),
  },
  workspaces: {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'wsA' }], recentWorkspaceId: 'ws9' }) },
    connectWorkspace: async (id: string) => { log.push(`connect:${id}`); return 's2' },
  },
})
await byDefault.run(fakeJob('', ''), fakeExec('e2', 'new-session'), (e) => { events2.push(e as never) })
console.log('blank/blank → default workspace new session:',
  log.includes('connect:ws9') && log.includes('rename:T')
  && events2.some(e => e.kind === 'started' && e.sessionId === 's2'))

// 3. named workspace — that workspace's new session
log.length = 0
const events3: Array<{ kind: string; sessionId?: string }> = []
const byWorkspace = new ExecutionService({
  sessions: {
    list: { getSnapshot: () => ({ phase: 'ready' as const, byId: { s3: { running: false } } }), subscribe: () => () => {} },
    binding: (id: string) => (id === 's3' ? { session: driver } : undefined),
  },
  workspaces: {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'wsA' }], recentWorkspaceId: 'ws9' }) },
    connectWorkspace: async (id: string) => { log.push(`connect:${id}`); return 's3' },
  },
})
await byWorkspace.run(fakeJob('', 'wsA'), fakeExec('e3', 'new-session'), (e) => { events3.push(e as never) })
console.log('named workspace → its new session:',
  log.includes('connect:wsA') && events3.some(e => e.kind === 'started' && e.sessionId === 's3'))
