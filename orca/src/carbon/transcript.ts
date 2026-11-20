// Token usage of a Claude Code transcript (one .jsonl file), per model and per day.
// Ported from claude-carbon's CC_JQ_FILE_USAGE (scripts/portable-lib.sh,
// https://github.com/gwittebolle/claude-carbon, MIT): an assistant message is keyed by
// message.id|requestId and its last occurrence wins (streaming snapshots grow
// output_tokens), a message with no model goes to the file's dominant model. Pure: no
// Orca and no Node API.

export type Tokens = {
  /** Uncached input (usage.input_tokens). */
  input: number
  /** Cache writes, both TTL tiers (usage.cache_creation_input_tokens). */
  cacheWrite: number
  /** The part of cacheWrite at the 1-hour tier. */
  cacheWrite1h: number
  cacheRead: number
  output: number
}

/** Tokens of one model on one day. */
export type UsageRow = { model: string; day: string; tokens: Tokens }

export const FALLBACK_MODEL = 'claude-sonnet'

export function emptyTokens(): Tokens {
  return { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output
  }
}

export function totalTokens(t: Tokens): number {
  return t.input + t.cacheWrite + t.cacheRead + t.output
}

/** The local calendar day (YYYY-MM-DD) of a time, or '' when it is not one. */
export function localDay(at: string | number | Date): string {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Message = { key: string | null; model: string; ts: string; tokens: Tokens }

function readMessage(line: unknown): Message | null {
  if (!isObject(line) || line.type !== 'assistant' || !isObject(line.message)) return null
  const usage = line.message.usage
  if (!isObject(usage)) return null
  const id = line.message.id
  const rid = line.requestId
  const creation = isObject(usage.cache_creation) ? usage.cache_creation : {}
  return {
    key: id != null && rid != null ? `${String(id)}|${String(rid)}` : null,
    model: typeof line.message.model === 'string' ? line.message.model : '',
    ts: typeof line.timestamp === 'string' ? line.timestamp : '',
    tokens: {
      input: n(usage.input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      cacheWrite1h: n(creation.ephemeral_1h_input_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      output: n(usage.output_tokens)
    }
  }
}

function dominantModel(messages: Message[]): string {
  const counts = new Map<string, number>()
  for (const m of messages) if (m.model) counts.set(m.model, (counts.get(m.model) ?? 0) + 1)
  let best = FALLBACK_MODEL
  let most = 0
  for (const [model, count] of counts) {
    if (count > most) {
      best = model
      most = count
    }
  }
  return best
}

/**
 * Usage rows of one transcript's text, one per (model, day). `dayOf` turns a message
 * timestamp into its day; a message without one falls on `fallbackDay`.
 */
export function parseTranscript(
  text: string,
  fallbackDay: string,
  dayOf: (ts: string) => string = localDay
): UsageRow[] {
  const keyed = new Map<string, Message>()
  const unkeyed: Message[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // a half-written last line, or a corrupt one: skip it
    }
    const message = readMessage(parsed)
    if (!message) continue
    if (message.key === null) unkeyed.push(message)
    else {
      // Delete first so the last occurrence also takes the last position.
      keyed.delete(message.key)
      keyed.set(message.key, message)
    }
  }
  const messages = [...keyed.values(), ...unkeyed]
  const dominant = dominantModel(messages)
  const rows = new Map<string, UsageRow>()
  for (const m of messages) {
    const model = m.model || dominant
    const day = (m.ts && dayOf(m.ts)) || fallbackDay
    const key = `${model}\u0000${day}`
    const row = rows.get(key)
    if (row) row.tokens = addTokens(row.tokens, m.tokens)
    else rows.set(key, { model, day, tokens: { ...m.tokens } })
  }
  return [...rows.values()]
}

/** Rows of several files summed per (model, day). */
export function mergeRows(rows: UsageRow[]): UsageRow[] {
  const merged = new Map<string, UsageRow>()
  for (const r of rows) {
    const key = `${r.model}\u0000${r.day}`
    const row = merged.get(key)
    if (row) row.tokens = addTokens(row.tokens, r.tokens)
    else merged.set(key, { model: r.model, day: r.day, tokens: { ...r.tokens } })
  }
  return [...merged.values()]
}

/** The first message time of a transcript, ms since epoch, or null when it has none. */
export function firstTimestamp(text: string): number | null {
  const match = /"timestamp":"([^"]+)"/.exec(text)
  if (!match) return null
  const at = Date.parse(match[1])
  return Number.isNaN(at) ? null : at
}

/** The working folder of a transcript's first message that names one, or null. */
export function firstCwd(text: string): string | null {
  const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}
