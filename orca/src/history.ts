// What the worker keeps in storage, one record per session, and the summary the panel and
// the status bar show. Pure: the worker does the storage and the file reading.
import type { Amount, SessionTotals } from './carbon/session.ts'
import type { Tokens } from './carbon/transcript.ts'

export type SessionRecord = Amount & {
  sessionId: string
  title: string | null
  /** When the worker last computed it, ms since epoch. */
  updatedAt: number
  /** The transcript files it was computed from (files.ts stampOf): unchanged, it is not redone. */
  stamp: string
  /** Orca workspace ids the session ran in (workspaceId and workspaceListId as Orca gives them). */
  workspaceIds?: string[]
  /** First message time, ms since epoch; null when the transcript has none. */
  startedAt?: number | null
  /** When a transcript file last changed, ms since epoch. */
  lastActiveAt?: number
  /** The folder Claude Code ran in, from the transcript. */
  cwd?: string | null
  /** The Orca workspace's name, when the session was seen in one. */
  workspaceName?: string | null
  tokens: Tokens
  models: { model: string; co2Grams: number; costUsd: number; excluded: boolean }[]
  days: Record<string, Amount>
}

/** Every stored session, by session id. */
export type History = Record<string, SessionRecord>

export type DayTotal = Amount & { day: string; sessions: number }

export type Summary = {
  today: string
  latest: SessionRecord | null
  todayTotal: DayTotal
  last30: Amount & { sessions: number }
  /** The last 30 days, oldest first, days with nothing included. */
  days: DayTotal[]
}

export const HISTORY_KEY = 'sessions'
export const SUMMARY_DAYS = 30

export function toRecord(
  sessionId: string,
  title: string | null,
  totals: SessionTotals,
  now: number,
  stamp: string,
  extra: {
    workspaceIds?: string[]
    startedAt?: number | null
    lastActiveAt?: number
    cwd?: string | null
    workspaceName?: string | null
  } = {}
): SessionRecord {
  return {
    sessionId,
    title,
    updatedAt: now,
    stamp,
    workspaceIds: extra.workspaceIds ?? [],
    startedAt: extra.startedAt ?? null,
    lastActiveAt: extra.lastActiveAt ?? now,
    cwd: extra.cwd ?? null,
    workspaceName: extra.workspaceName ?? null,
    co2Grams: totals.co2Grams,
    costUsd: totals.costUsd,
    tokens: totals.tokens,
    models: totals.models.map(({ model, co2Grams, costUsd, excluded }) => ({
      model,
      co2Grams,
      costUsd,
      excluded
    })),
    days: totals.days
  }
}

/**
 * The history with this session's record put in place of any earlier one: the worker
 * recomputes a session from its whole transcript, so the same session done twice is
 * stored once. A record keeps the title it had when the new one has none, and every
 * workspace it was seen in.
 */
export function upsert(history: History, record: SessionRecord): History {
  const previous = history[record.sessionId]
  return {
    ...history,
    [record.sessionId]: {
      ...record,
      title: record.title ?? previous?.title ?? null,
      workspaceName: record.workspaceName ?? previous?.workspaceName ?? null,
      workspaceIds: mergeIds(previous?.workspaceIds, record.workspaceIds)
    }
  }
}

export function mergeIds(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])]
}

/** A session as the workspace picker lists it. */
export type FocusSession = SessionRecord & { label: string }

export type Focus = {
  /** The id `workspace.readContext` gives; null when Orca gives none. */
  workspaceId: string | null
  name: string
  /** Most recently active first. */
  sessions: FocusSession[]
  /** The session the card shows; null when the workspace has none. */
  selected: string | null
}

/** Picked session per workspace id, kept in storage under PICKS_KEY. */
export type Picks = Record<string, string>

export const PICKS_KEY = 'picks'

function activity(record: SessionRecord): number {
  return record.lastActiveAt ?? record.updatedAt
}

function startLabel(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Started ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The focused workspace's sessions: those stored with one of its ids, and those Orca lists
 * as running in it (`live`, session id to agent title). Labeled by title, else start time.
 * The picked session wins when it is listed; else the most recently active one.
 */
export function focusOf(
  history: History,
  workspace: { ids: string[]; name: string; workspaceId: string | null },
  live: Record<string, string | null>,
  picks: Picks
): Focus {
  const sessions: FocusSession[] = Object.values(history)
    .filter(
      (r) =>
        r.sessionId in live || (r.workspaceIds ?? []).some((id) => workspace.ids.includes(id))
    )
    .sort((a, b) => activity(b) - activity(a))
    .map((r) => {
      const title = live[r.sessionId] || r.title
      const started = r.startedAt ?? null
      return {
        ...r,
        label: title || (started !== null ? startLabel(started) : r.sessionId.slice(0, 8))
      }
    })
  const picked = workspace.workspaceId ? picks[workspace.workspaceId] : undefined
  const selected = sessions.some((s) => s.sessionId === picked)
    ? (picked as string)
    : (sessions[0]?.sessionId ?? null)
  return { workspaceId: workspace.workspaceId, name: workspace.name, sessions, selected }
}

/** Days before `today` minus `count - 1`, as YYYY-MM-DD, oldest first. */
export function lastDays(today: string, count: number): string[] {
  const [y, m, d] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(y, m - 1, d - i)
    const pad = (v: number) => String(v).padStart(2, '0')
    out.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
  }
  return out
}

export function summarize(history: History, today: string): Summary {
  const window = lastDays(today, SUMMARY_DAYS)
  const byDay = new Map<string, DayTotal>(
    window.map((day) => [day, { day, co2Grams: 0, costUsd: 0, sessions: 0 }])
  )
  let latest: SessionRecord | null = null
  const inWindow = new Set<string>()
  for (const record of Object.values(history)) {
    if (!latest || record.updatedAt > latest.updatedAt) latest = record
    for (const [day, amount] of Object.entries(record.days)) {
      const total = byDay.get(day)
      if (!total) continue
      total.co2Grams += amount.co2Grams
      total.costUsd += amount.costUsd
      total.sessions += 1
      inWindow.add(record.sessionId)
    }
  }
  const days = [...byDay.values()]
  return {
    today,
    latest,
    todayTotal: byDay.get(today) ?? { day: today, co2Grams: 0, costUsd: 0, sessions: 0 },
    last30: {
      co2Grams: days.reduce((sum, d) => sum + d.co2Grams, 0),
      costUsd: days.reduce((sum, d) => sum + d.costUsd, 0),
      sessions: inWindow.size
    },
    days
  }
}
