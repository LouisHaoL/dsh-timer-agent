/**
 * Session-target tree: enumerates the HOST workspace registry (via
 * /api/dsh-timer-agent/workspaces → canonical paths) and the client
 * session list (per-session pinning) into a collapsible-picker data tree.
 *
 * Tree shape (hermes-cron semantics):
 * - a leading default group (blank workdir): "new conversation in the
 *   default workspace" plus its cwd-less sessions;
 * - one group per registered workspace: "new session in this project"
 *   plus that project's sessions (matched by session cwd);
 * - fallback groups for cwd directories the registry does not know.
 *
 * Each group carries its own "new session" leaf (workdir set, sessionId
 * blank); each session leaf pins that conversation (sessionId set).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** One pinned-session leaf. */
export interface TargetSession {
  id: string
  title: string
}

/** One collapsible group = one workspace (or the default bucket). */
export interface TargetGroup {
  /** Stable group key. */
  key: string
  /** Short display name (project basename, or 默认 for the default bucket). */
  name: string
  /** Full workdir ('' = default workspace). */
  workdir: string
  /** Pinnable sessions under this workspace, most recent first. */
  sessions: TargetSession[]
}

/** Flat selection value the picker resolves to. */
export interface TargetSelection {
  workdir: string
  sessionId: string
}

/** One workspace row from the host registry. */
interface WorkspaceRow { id: string; path: string }

/** One session row projected from the client sessions store. */
interface SessionRow {
  id: string
  title: string
  cwd: string
  updatedAt: number
}

/** Cap per group so the tree stays usable. */
const SESSIONS_PER_GROUP = 20

/** Fetch the host workspace registry (empty when the route is unreachable). */
async function hostWorkspaces(): Promise<WorkspaceRow[]> {
  try {
    const response = await fetch('/api/dsh-timer-agent/workspaces')
    if (!response.ok) return []
    const body = await response.json() as { workspaces?: WorkspaceRow[] }
    return body.workspaces ?? []
  } catch {
    return []
  }
}

/** Project the client sessions store into flat rows (blank/subagent rows dropped). */
function sessionRows(ctx: ClientContext): SessionRow[] {
  try {
    // Structural read: the ambient cordis Context augmentation merges several
    // `sessions` seats (the client runtime's ISessions face is the runtime
    // truth; its `list` is an ObservableSnapshot<SessionListState>).
    const sessions = (ctx as unknown as {
      sessions?: {
        list?: { getSnapshot?(): unknown }
      }
    }).sessions
    const snapshot = sessions?.list?.getSnapshot?.() as {
      byId?: Record<string, {
        id?: string
        displayTitle?: string
        title?: string
        cwd?: string
        blank?: boolean
        origin?: string
        updatedAt?: number
      }>
    } | undefined
    const rows: SessionRow[] = []
    for (const summary of Object.values(snapshot?.byId ?? {})) {
      if (summary?.id === undefined) continue
      if (summary.blank === true) continue
      if (summary.origin === 'subagent') continue
      rows.push({
        id: summary.id,
        title: summary.displayTitle ?? summary.title ?? summary.id,
        cwd: summary.cwd ?? '',
        updatedAt: summary.updatedAt ?? 0,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  } catch {
    return []
  }
}

/** Last non-empty path segment (both separators), for short labels. */
function pathBasename(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop()
  return name ?? path
}

/** Normalize a path for matching (case/fold, forward slashes, no trailing). */
function normPath(path: string): string {
  let p = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  // Drive letter casing on Windows: normalize c:/ vs C:/.
  if (p.length >= 2 && p[1] === ':') p = p[0].toUpperCase() + p.slice(1)
  return p
}

/**
 * Build the target tree. Always leads with the default-workspace group.
 * @param ctx - client root context (sessions face for pinning).
 * @returns ordered groups.
 */
export async function listTargetOptions(ctx: ClientContext): Promise<TargetGroup[]> {
  const [workspaces, sessions] = await Promise.all([
    hostWorkspaces(),
    Promise.resolve(sessionRows(ctx)),
  ])

  // Buckets keyed by normalized path ('' for the default workspace).
  const byBucket = new Map<string, SessionRow[]>()
  for (const session of sessions) {
    const key = session.cwd === '' ? '' : normPath(session.cwd)
    const bucket = byBucket.get(key) ?? []
    if (bucket.length < SESSIONS_PER_GROUP) bucket.push(session)
    byBucket.set(key, bucket)
  }

  const toGroup = (key: string, name: string, workdir: string): TargetGroup => ({
    key,
    name,
    workdir,
    sessions: (byBucket.get(normPath(workdir)) ?? []).map(session => ({
      id: session.id,
      title: session.title,
    })),
  })

  const groups: TargetGroup[] = [
    toGroup('default', '默认工作空间', ''),
  ]

  const seen = new Set<string>([''])
  for (const workspace of workspaces) {
    const key = normPath(workspace.path)
    if (seen.has(key)) continue
    seen.add(key)
    groups.push(toGroup(`ws:${workspace.id}`, pathBasename(workspace.path), workspace.path))
  }
  // Leftover buckets (cwd set, workspace not in the host registry).
  for (const [key, bucket] of byBucket) {
    if (key === '' || seen.has(key)) continue
    const path = bucket[0]?.cwd ?? key
    seen.add(key)
    groups.push(toGroup(`cwd:${key.replaceAll(':', '_')}`, pathBasename(path), path))
  }

  return groups
}
