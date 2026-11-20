// What the panel's history draws, computed by the worker from the stored sessions: totals per
// period, a bar per day coloured against the median day, and the split by model and by
// workspace. Sent instead of the records, so a post stays small. Pure.
import { classOf, median } from './carbon/palette.ts'
import type { Amount } from './carbon/session.ts'
import { lastDays, type History, type SessionRecord } from './history.ts'

export const PERIODS = ['7', '30', '90', 'all'] as const
export type Period = (typeof PERIODS)[number]

export type Slice = Amount & { name: string }

/** `cls` is the colour class against the median day (palette.ts); null when there is none. */
export type DayBar = Amount & { day: string; cls: number | null }

export type PeriodView = Amount & {
  sessions: number
  /** Oldest first, days with nothing included. */
  days: DayBar[]
  byModel: Slice[]
  byWorkspace: Slice[]
}

export type Insights = {
  /** Median CO2 of a session, the current session's colour scale; 0 with too few sessions. */
  sessionMedian: number
  /** Median CO2 of a day with any, the bars' and stripes' colour scale. */
  dayMedian: number
  periods: Record<Period, PeriodView>
}

const MAX_SLICES = 5

/** The Orca workspace's name, else the last folder of where Claude Code ran. */
export function workspaceLabel(record: SessionRecord): string {
  if (record.workspaceName) return record.workspaceName
  const cwd = record.cwd?.replace(/[\\/]+$/, '')
  if (cwd) return cwd.split(/[\\/]/).pop() || cwd
  return 'Unknown'
}

function addTo(map: Map<string, Amount>, name: string, co2Grams: number, costUsd: number): void {
  const slice = map.get(name) ?? { co2Grams: 0, costUsd: 0 }
  slice.co2Grams += co2Grams
  slice.costUsd += costUsd
  map.set(name, slice)
}

/** Largest first; past MAX_SLICES, the rest as one "Other". */
function slices(map: Map<string, Amount>): Slice[] {
  const all = [...map.entries()]
    .map(([name, a]) => ({ name, ...a }))
    .filter((s) => s.co2Grams > 0)
    .sort((a, b) => b.co2Grams - a.co2Grams)
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

export function insights(history: History, today: string): Insights {
  const records = Object.values(history)
  const byDay = new Map<string, Amount>()
  for (const r of records) {
    for (const [day, a] of Object.entries(r.days)) addTo(byDay, day, a.co2Grams, a.costUsd)
  }
  const sessionMedian = median(records.map((r) => r.co2Grams))
  const dayMedian = median([...byDay.values()].map((a) => a.co2Grams))
  const firstDay = [...byDay.keys()].filter((d) => d <= today).sort()[0] ?? today

  const view = (count: number): PeriodView => {
    const window = lastDays(today, count)
    const inWindow = new Set(window)
    const models = new Map<string, Amount>()
    const workspaces = new Map<string, Amount>()
    let sessions = 0
    for (const r of records) {
      let co2 = 0
      let cost = 0
      for (const [day, a] of Object.entries(r.days)) {
        if (!inWindow.has(day)) continue
        co2 += a.co2Grams
        cost += a.costUsd
      }
      if (co2 === 0 && cost === 0) continue
      sessions += 1
      addTo(workspaces, workspaceLabel(r), co2, cost)
      // Models carry no days: the session's share in the window, split as its models are.
      const share = r.co2Grams > 0 ? co2 / r.co2Grams : 0
      for (const m of r.models) {
        if (!m.excluded) addTo(models, m.model, m.co2Grams * share, m.costUsd * share)
      }
    }
    const days = window.map((day) => {
      const a = byDay.get(day) ?? { co2Grams: 0, costUsd: 0 }
      return {
        day,
        co2Grams: a.co2Grams,
        costUsd: a.costUsd,
        cls: a.co2Grams > 0 && dayMedian > 0 ? classOf(a.co2Grams, dayMedian) : null
      }
    })
    return {
      co2Grams: days.reduce((sum, d) => sum + d.co2Grams, 0),
      costUsd: days.reduce((sum, d) => sum + d.costUsd, 0),
      sessions,
      days,
      byModel: slices(models),
      byWorkspace: slices(workspaces)
    }
  }

  return {
    sessionMedian,
    dayMedian,
    periods: {
      '7': view(7),
      '30': view(30),
      '90': view(90),
      all: view(dayCount(firstDay, today))
    }
  }
}
