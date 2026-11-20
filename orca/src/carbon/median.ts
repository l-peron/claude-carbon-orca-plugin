// The median a session is compared with: median from hooks/mod/lib/format.ts, MIN_SESSIONS,
// pastSessions and sessionMedian from hooks/mod/lib/sessions.ts, and the ratio's rounding
// from currentLine in format.ts, copied from claude-carbon
// (https://github.com/gwittebolle/claude-carbon at 9ad53f1), MIT License, Copyright (c)
// 2026 Gaetan Wittebolle. See LICENSE at the repository root. English only here.
// Pure: no Orca and no Node API.

// Below this many past sessions there is no median of one's own.
export const MIN_SESSIONS = 10

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}

/** Every session but the current one. */
export function pastSessions<T extends { id: string }>(rows: readonly T[], currentId: string | null): T[] {
  return currentId === null ? [...rows] : rows.filter((r) => r.id !== currentId)
}

/** The median of the past sessions' CO2, or null with too few of them. */
export function sessionMedian(past: readonly { grams: number }[]): number | null {
  if (past.length < MIN_SESSIONS) return null
  const m = median(past.map((r) => r.grams))
  return m > 0 ? m : null
}

/** "12", "1.5", "0.35": whole above 10, one decimal above 1, else two. */
export function ratioText(grams: number, sessionMedian: number): string {
  const r = grams / sessionMedian
  return r >= 10 ? `${Math.round(r)}` : r.toFixed(r >= 1 ? 1 : 2)
}
