// Token usage of a Claude Code transcript (one .jsonl file), per model and per day.
// Ported from claude-carbon's CC_JQ_FILE_USAGE (scripts/portable-lib.sh,
// https://github.com/gwittebolle/claude-carbon, MIT): an assistant message is keyed by
// message.id|requestId and its last occurrence wins (streaming snapshots grow
// output_tokens), a message with no model goes to the file's dominant model. Pure: no
// Orca and no Node API.

/** Bumped whenever what a file's lines give changes: stored sessions are then read again. */
export const PARSER_VERSION = 2

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

type Message = { model: string; ts: string; tokens: Tokens }

/**
 * One file's assistant messages, fed a line at a time, so a file that grows is read from
 * where it was left (src/reader.ts). Also keeps the first timestamp and working folder.
 */
export class FileUsage {
  private keyed = new Map<string, Message>()
  private unkeyed: Message[] = []
  /** First message time, ms since epoch; null until a line has one. */
  firstTimestamp: number | null = null
  /** The working folder of the first line that names one. */
  cwd: string | null = null

  addLine(raw: string): void {
    if (!raw.trim()) return
    let line: unknown
    try {
      line = JSON.parse(raw)
    } catch {
      return // a half-written last line, or a corrupt one: skip it
    }
    if (!isObject(line)) return
    if (this.firstTimestamp === null && typeof line.timestamp === 'string') {
      const at = Date.parse(line.timestamp)
      if (!Number.isNaN(at)) this.firstTimestamp = at
    }
    if (this.cwd === null && typeof line.cwd === 'string' && line.cwd) this.cwd = line.cwd
    if (line.type !== 'assistant' || !isObject(line.message)) return
    const usage = line.message.usage
    if (!isObject(usage)) return
    const id = line.message.id
    const rid = line.requestId
    const creation = isObject(usage.cache_creation) ? usage.cache_creation : {}
    const message: Message = {
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
    if (id == null || rid == null) {
      this.unkeyed.push(message)
      return
    }
    const key = `${String(id)}|${String(rid)}`
    // Delete first so the last occurrence also takes the last position.
    this.keyed.delete(key)
    this.keyed.set(key, message)
  }

  /**
   * One row per (model, day). `dayOf` turns a message timestamp into its day; a message
   * without one falls on `fallbackDay`.
   */
  rows(fallbackDay: string, dayOf: (ts: string) => string = localDay): UsageRow[] {
    const messages = [...this.keyed.values(), ...this.unkeyed]
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
}

/** The most frequent model; a tie goes to the first by name, as jq's group_by sorts. */
function dominantModel(messages: Message[]): string {
  const counts = new Map<string, number>()
  for (const m of messages) if (m.model) counts.set(m.model, (counts.get(m.model) ?? 0) + 1)
  let best = FALLBACK_MODEL
  let most = 0
  for (const [model, count] of counts) {
    if (count > most || (count === most && model < best)) {
      best = model
      most = count
    }
  }
  return best
}

/** Usage rows of one transcript's whole text (see FileUsage.rows). */
export function parseTranscript(
  text: string,
  fallbackDay: string,
  dayOf: (ts: string) => string = localDay
): UsageRow[] {
  const usage = new FileUsage()
  for (const raw of text.split('\n')) usage.addLine(raw)
  return usage.rows(fallbackDay, dayOf)
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
