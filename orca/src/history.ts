// What the worker keeps in storage, one record per session, and how a record is priced.
// A record holds raw tokens per model and day, so CO2 and cost always use the factors and
// prices loaded now: a new factors.json applies to the whole history at once. Pure: the
// worker does the storage and the file reading.
import type { Factors } from './carbon/co2.ts'
import type { Prices } from './carbon/cost.ts'
import { sessionTotals, type Amount } from './carbon/session.ts'
import { emptyTokens, type Tokens, type UsageRow } from './carbon/transcript.ts'

/** The storage layout; `migrate` brings older ones up to it. */
export const SCHEMA_VERSION = 2
export const SCHEMA_KEY = 'schema'
export const HISTORY_KEY = 'sessions'
/** Picked session per workspace id. */
export const PICKS_KEY = 'picks'
/** The last focused workspace, so a restarted worker shows it before Orca's next event. */
export const FOCUS_KEY = 'focus'
/** When the last full import ended. */
export const BACKFILL_KEY = 'backfill'

export type ModelAmount = Amount & { model: string; excluded: boolean }

/** What a schema 1 record held, kept until its transcript is read again. */
export type LegacyAmounts = Amount & {
  tokens: Tokens
  models: ModelAmount[]
  days: Record<string, Amount>
}

export type SessionRecord = {
  sessionId: string
  title: string | null
  /** When the worker last computed it, ms since epoch. */
  updatedAt: number
  /** The transcript files and parser it was computed from (files.ts stampOf); '' to redo. */
  stamp: string
  /** When a transcript file last changed, ms since epoch: a record from older files never replaces it. */
  lastActiveAt: number
  /** First message time, ms since epoch; null when the transcript has none. */
  startedAt: number | null
  /** The folder Claude Code ran in, from the transcript. */
  cwd: string | null
  /** Orca workspace ids the session ran in (workspaceId and workspaceListId as Orca gives them). */
  workspaceIds: string[]
  /** The Orca workspace's name when it was last seen in one. */
  workspaceName: string | null
  /** Tokens per model and day, main transcript and subagents merged. */
  usage: UsageRow[]
  /** Schema 1 amounts, for a record whose transcript is no longer on disk to read. */
  legacy?: LegacyAmounts
}

/** Every stored session, by session id. */
export type History = Record<string, SessionRecord>

/** Picked session per workspace id, kept in storage under PICKS_KEY. */
export type Picks = Record<string, string>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * The stored history in the current schema. Schema 1 (no version stored) kept priced amounts
 * only: its records keep their names and workspaces, their amounts as `legacy`, and an empty
 * stamp, so the next import reads them all again. Anything unreadable is dropped.
 */
export function migrate(raw: unknown, version: unknown): History {
  if (!isObject(raw)) return {}
  const history: History = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value)) continue
    const ids = Array.isArray(value.workspaceIds)
      ? value.workspaceIds.filter((w): w is string => typeof w === 'string')
      : []
    const base = {
      sessionId: id,
      title: str(value.title),
      updatedAt: num(value.updatedAt, 0),
      lastActiveAt: num(value.lastActiveAt, num(value.updatedAt, 0)),
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : null,
      cwd: str(value.cwd),
      workspaceIds: ids,
      workspaceName: str(value.workspaceName)
    }
    if (version === SCHEMA_VERSION && Array.isArray(value.usage)) {
      history[id] = {
        ...base,
        stamp: str(value.stamp) ?? '',
        usage: value.usage as UsageRow[],
        ...(isObject(value.legacy) ? { legacy: value.legacy as unknown as LegacyAmounts } : {})
      }
    } else if (typeof value.co2Grams === 'number') {
      history[id] = {
        ...base,
        stamp: '',
        usage: [],
        legacy: {
          co2Grams: value.co2Grams,
          costUsd: num(value.costUsd, 0),
          tokens: isObject(value.tokens) ? (value.tokens as unknown as Tokens) : emptyTokens(),
          models: Array.isArray(value.models) ? (value.models as ModelAmount[]) : [],
          days: isObject(value.days) ? (value.days as Record<string, Amount>) : {}
        }
      }
    }
  }
  return history
}

export function mergeIds(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])]
}

/**
 * The history with this session's record in place of the stored one. The worker recomputes
 * a session from its whole transcript, so the same session done twice is stored once. A
 * record read from older files than the stored one (an import that read a session while a
 * turn ended) does not replace it; either way the names and workspaces it carries are kept.
 */
export function upsert(history: History, record: SessionRecord): History {
  const previous = history[record.sessionId]
  const meta = {
    title: record.title ?? previous?.title ?? null,
    workspaceName: record.workspaceName ?? previous?.workspaceName ?? null,
    workspaceIds: mergeIds(previous?.workspaceIds, record.workspaceIds)
  }
  const stale = previous !== undefined && previous.stamp !== '' && previous.lastActiveAt > record.lastActiveAt
  return {
    ...history,
    [record.sessionId]: { ...(stale ? previous : record), ...meta }
  }
}

/** A record with its CO2 and cost at the factors and prices given. */
export type Priced = Amount & {
  record: SessionRecord
  tokens: Tokens
  /** Largest first; excluded models (not Claude, or exclude_models) count 0. */
  models: ModelAmount[]
  /** Per local day the session's messages fell on; days with nothing left out. */
  days: Record<string, Amount>
}

export function price(record: SessionRecord, factors: Factors, prices: Prices | null): Priced {
  if (record.usage.length === 0 && record.legacy) {
    const { co2Grams, costUsd, tokens, models, days } = record.legacy
    return { record, co2Grams, costUsd, tokens, models, days: nonZeroDays(days) }
  }
  const totals = sessionTotals(record.usage, factors, prices)
  return {
    record,
    co2Grams: totals.co2Grams,
    costUsd: totals.costUsd,
    tokens: totals.tokens,
    models: totals.models.map(({ model, co2Grams, costUsd, excluded }) => ({
      model,
      co2Grams,
      costUsd,
      excluded
    })),
    days: nonZeroDays(totals.days)
  }
}

function nonZeroDays(days: Record<string, Amount>): Record<string, Amount> {
  return Object.fromEntries(
    Object.entries(days).filter(([, a]) => a.co2Grams > 0 || a.costUsd > 0)
  )
}

/** The session that was active last; null with none. */
export function latestOf(sessions: Priced[]): Priced | null {
  let latest: Priced | null = null
  for (const s of sessions) {
    if (!latest || s.record.lastActiveAt > latest.record.lastActiveAt) latest = s
  }
  return latest
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
