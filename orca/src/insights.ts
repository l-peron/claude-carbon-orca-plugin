// What the panel's history and the status bar show, computed by the worker from the priced
// sessions: today, totals per period, a bar per day (per week past BARS_MAX_DAYS), and the
// split by model and by workspace. Sent instead of the records, so a post stays small. Pure.
import type { Amount } from './carbon/session.ts'
import { lastDays, type Priced } from './history.ts'
import { workspaceLabel, type Workspace } from './workspaces.ts'

export const PERIODS = ['7', '30', '90', 'all'] as const
export type Period = (typeof PERIODS)[number]

export type Slice = Amount & { name: string }

/** One bar: a day, or a week starting on `day`. */
export type Bar = Amount & { day: string }

export type PeriodView = Amount & {
  sessions: number
  /** What one bar covers; weeks only when the period is longer than BARS_MAX_DAYS. */
  bar: 'day' | 'week'
  /** Oldest first, empty days included; the last one holds today. */
  bars: Bar[]
  /** The period's first and last day. */
  from: string
  to: string
  byModel: Slice[]
  byWorkspace: Slice[]
}

export type Insights = {
  today: Amount & { sessions: number }
  periods: Record<Period, PeriodView>
}

const MAX_SLICES = 5
/** Above this many days a period draws a bar per week, so "All" stays readable. */
export const BARS_MAX_DAYS = 120

function addTo(map: Map<string, Slice>, key: string, name: string, co2Grams: number, costUsd: number): void {
  const slice = map.get(key) ?? { name, co2Grams: 0, costUsd: 0 }
  slice.co2Grams += co2Grams
  slice.costUsd += costUsd
  map.set(key, slice)
}

/** Largest first; past MAX_SLICES, the rest as one "Other". */
function slices(map: Map<string, Slice>): Slice[] {
  const all = [...map.values()].filter((s) => s.co2Grams > 0).sort((a, b) => b.co2Grams - a.co2Grams)
  if (all.length <= MAX_SLICES + 1) return all
  const rest = all.slice(MAX_SLICES)
  return [
    ...all.slice(0, MAX_SLICES),
    {
      name: `Other (${rest.length})`,
      co2Grams: rest.reduce((sum, s) => sum + s.co2Grams, 0),
      costUsd: rest.reduce((sum, s) => sum + s.costUsd, 0)
    }
  ]
}

function dayCount(first: string, today: string): number {
  const [y1, m1, d1] = first.split('-').map(Number)
  const [y2, m2, d2] = today.split('-').map(Number)
  const ms = new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()
  return Math.max(1, Math.round(ms / 86_400_000) + 1)
}

/** Day bars, or week bars counted back from today so the last one ends today. */
function barsOf(window: string[], byDay: Map<string, Amount>): { bar: 'day' | 'week'; bars: Bar[] } {
  const amount = (day: string) => byDay.get(day) ?? { co2Grams: 0, costUsd: 0 }
  if (window.length <= BARS_MAX_DAYS) {
    return { bar: 'day', bars: window.map((day) => ({ day, ...amount(day) })) }
  }
  const bars: Bar[] = []
  for (let end = window.length; end > 0; end -= 7) {
    const days = window.slice(Math.max(0, end - 7), end)
    bars.unshift({
      day: days[0],
      co2Grams: days.reduce((sum, d) => sum + amount(d).co2Grams, 0),
      costUsd: days.reduce((sum, d) => sum + amount(d).costUsd, 0)
    })
  }
  return { bar: 'week', bars }
}

export function insights(sessions: Priced[], today: string, workspaces: Workspace[]): Insights {
  const byDay = new Map<string, Amount>()
  const sessionsToday = new Set<string>()
  for (const s of sessions) {
    for (const [day, a] of Object.entries(s.days)) {
      const total = byDay.get(day) ?? { co2Grams: 0, costUsd: 0 }
      total.co2Grams += a.co2Grams
      total.costUsd += a.costUsd
      byDay.set(day, total)
      if (day === today) sessionsToday.add(s.record.sessionId)
    }
  }
  const firstDay = [...byDay.keys()].filter((d) => d <= today).sort()[0] ?? today
  const labels = new Map(sessions.map((s) => [s.record.sessionId, workspaceLabel(s.record, workspaces)]))

  const view = (count: number): PeriodView => {
    const window = lastDays(today, count)
    const inWindow = new Set(window)
    const models = new Map<string, Slice>()
    const places = new Map<string, Slice>()
    let co2Grams = 0
    let costUsd = 0
    let sessionCount = 0
    for (const s of sessions) {
      let co2 = 0
      let cost = 0
      for (const [day, a] of Object.entries(s.days)) {
        if (!inWindow.has(day)) continue
        co2 += a.co2Grams
        cost += a.costUsd
      }
      if (co2 === 0 && cost === 0) continue
      sessionCount += 1
      co2Grams += co2
      costUsd += cost
      const place = labels.get(s.record.sessionId)!
      addTo(places, place.key, place.name, co2, cost)
      // Models carry no days: the session's share in the window, split as its models are.
      const share = s.co2Grams > 0 ? co2 / s.co2Grams : 0
      for (const m of s.models) {
        if (!m.excluded) addTo(models, m.model, m.model, m.co2Grams * share, m.costUsd * share)
      }
    }
    return {
      co2Grams,
      costUsd,
      sessions: sessionCount,
      ...barsOf(window, byDay),
      from: window[0],
      to: window[window.length - 1],
      byModel: slices(models),
      byWorkspace: slices(places)
    }
  }

  const todayAmount = byDay.get(today) ?? { co2Grams: 0, costUsd: 0 }
  return {
    today: { ...todayAmount, sessions: sessionsToday.size },
    periods: {
      '7': view(7),
      '30': view(30),
      '90': view(90),
      all: view(dayCount(firstDay, today))
    }
  }
}
