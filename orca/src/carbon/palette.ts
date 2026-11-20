// The intensity colours of claude-carbon's molecule and warming stripes: PALETTE, NEUTRAL,
// OUTLINE, classOf and colorOf copied from claude-carbon
// (https://github.com/gwittebolle/claude-carbon, hooks/mod/lib/mascot.ts at 9ad53f1),
// MIT License, Copyright (c) 2026 Gaetan Wittebolle. See LICENSE at the
// repository root. median is ours.
// Pure: no Orca and no Node API.

// Dark blue to dark red, one colour per power of two around the median: the bluest under
// an eighth of it, the reddest over eight times it.
export const PALETTE = [
  '#08306b',
  '#2166ac',
  '#6aa6d0',
  '#c6dbef',
  '#fcbba1',
  '#ef6548',
  '#c41a1d',
  '#67000d'
] as const
// Too little history to compare against: grey.
export const NEUTRAL = '#8b949e'
// The outline that keeps the darkest colours visible on a dark background.
export const OUTLINE = '#8b949e'

export function classOf(grams: number, median: number): number {
  if (!(median > 0) || !(grams > 0)) return 0
  const cls = Math.floor(Math.log2(grams / median)) + 4
  return Math.min(7, Math.max(0, cls))
}

export function colorOf(cls: number | null): string {
  return cls === null ? NEUTRAL : (PALETTE[cls] ?? NEUTRAL)
}

/** The median of the positive values; 0 when there are fewer than `min` of them. */
export function median(values: number[], min = 3): number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (sorted.length < min) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
