// Which Orca workspace a session belongs to, and the sessions of the focused one. Pure.
import { pastSessions, sessionMedian } from './carbon/median.ts'
import type { Tokens } from './carbon/transcript.ts'
import type { ModelAmount, Picks, Priced } from './history.ts'

/** A row of `workspace.list`. */
export type Workspace = { id: string; name: string; path: string }

/** The workspace Orca has in focus, as `workspace.changed` gives it. */
export type Focused = { workspaceId: string | null; name: string }

function within(cwd: string, path: string): boolean {
  const root = path.replace(/[\\/]+$/, '')
  return root !== '' && (cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`))
}

/**
 * The workspace a session ran in: one Orca tied it to, else the deepest one whose folder
 * holds the session's working folder; null when none does.
 */
export function workspaceOf(
  record: { workspaceIds: string[]; cwd: string | null },
  workspaces: Workspace[]
): Workspace | null {
  const tied = workspaces.find((w) => record.workspaceIds.includes(w.id))
  if (tied) return tied
  const cwd = record.cwd
  if (!cwd) return null
  let best: Workspace | null = null
  for (const w of workspaces) {
    if (within(cwd, w.path) && (!best || w.path.length > best.path.length)) best = w
  }
  return best
}

/** How the history groups a session: its workspace, else its last name, else its folder. */
export function workspaceLabel(
  record: { workspaceIds: string[]; cwd: string | null; workspaceName: string | null },
  workspaces: Workspace[]
): { key: string; name: string } {
  const w = workspaceOf(record, workspaces)
  if (w) return { key: `id:${w.id}`, name: w.name }
  if (record.workspaceName) return { key: `name:${record.workspaceName}`, name: record.workspaceName }
  const cwd = record.cwd?.replace(/[\\/]+$/, '')
  if (cwd) {
    const name = cwd.split(/[\\/]/).pop() || cwd
    return { key: `name:${name}`, name }
  }
  return { key: 'unknown', name: 'Unknown' }
}

/** A session as the panel shows it: no transcript paths, no per-day data. */
export type SessionView = {
  sessionId: string
  title: string | null
  startedAt: number | null
  updatedAt: number
  co2Grams: number
  costUsd: number
  tokens: Tokens
  /** Claude models only, largest first. */
  models: Omit<ModelAmount, 'excluded'>[]
}

export type Focus = {
  /** The id `workspace.readContext` gives; null when Orca gives none. */
  workspaceId: string | null
  name: string
  /** Most recently active first. */
  sessions: SessionView[]
  /** The session the card shows; null when the workspace has none. */
  selected: string | null
  /** Median CO2 of every other session, as claude-carbon compares; null with fewer than 10. */
  median: number | null
}

export function sessionView(s: Priced, title: string | null = s.record.title): SessionView {
  return {
    sessionId: s.record.sessionId,
    title,
    startedAt: s.record.startedAt,
    updatedAt: s.record.updatedAt,
    co2Grams: s.co2Grams,
    costUsd: s.costUsd,
    tokens: s.tokens,
    models: s.models
      .filter((m) => !m.excluded)
      .map(({ model, co2Grams, costUsd }) => ({ model, co2Grams, costUsd }))
  }
}

/**
 * The focused workspace's sessions: those Orca tied to it, those Orca lists as running in
 * it (`live`, session id to agent title), and those whose folder is inside it. The picked
 * session wins when it is listed; else the most recently active one.
 */
export function focusOf(
  all: Priced[],
  focused: Focused,
  workspaces: Workspace[],
  live: Record<string, string | null>,
  picks: Picks
): Focus {
  const id = focused.workspaceId
  const named = workspaces.filter((w) => w.name === focused.name)
  const entry =
    workspaces.find((w) => w.id === id) ?? (named.length === 1 ? named[0] : undefined)
  const mine = all
    .filter((s) => {
      const r = s.record
      if (r.sessionId in live || (id !== null && r.workspaceIds.includes(id))) return true
      return entry !== undefined && workspaceOf(r, workspaces)?.id === entry.id
    })
    .sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt)
  const picked = id ? picks[id] : undefined
  const selected = mine.some((s) => s.record.sessionId === picked)
    ? (picked as string)
    : (mine[0]?.record.sessionId ?? null)
  const past = pastSessions(
    all.map((s) => ({ id: s.record.sessionId, grams: s.co2Grams })),
    selected
  )
  return {
    workspaceId: id,
    name: focused.name,
    sessions: mine.map((s) => sessionView(s, live[s.record.sessionId] || s.record.title)),
    selected,
    median: sessionMedian(past)
  }
}
