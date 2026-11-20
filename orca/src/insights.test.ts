import { assert, test } from 'orca/testing'
import { classOf, median } from './carbon/palette.ts'
import type { SessionRecord } from './history.ts'
import { insights, workspaceLabel } from './insights.ts'

const tokens = { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }

function record(id: string, days: Record<string, number>, extra: Partial<SessionRecord> = {}): SessionRecord {
  const total = Object.values(days).reduce((a, b) => a + b, 0)
  return {
    sessionId: id,
    title: null,
    updatedAt: 1,
    stamp: '',
    co2Grams: total,
    costUsd: total / 10,
    tokens,
    models: [
      { model: 'claude-opus-5-5', co2Grams: total * 0.75, costUsd: total / 40 * 3, excluded: false },
      { model: 'claude-haiku-4-5', co2Grams: total * 0.25, costUsd: total / 40, excluded: false }
    ],
    days: Object.fromEntries(Object.entries(days).map(([d, g]) => [d, { co2Grams: g, costUsd: g / 10 }])),
    ...extra
  }
}

test('median and colour classes follow upstream', () => {
  assert.equal(median([1, 2]), 0)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2, 0]), 2.5)
  assert.equal(classOf(10, 10), 4)
  assert.equal(classOf(1, 10), 0)
  assert.equal(classOf(1000, 10), 7)
  assert.equal(classOf(5, 10), 3)
})

test('labels a workspace by its Orca name, else the folder Claude ran in', () => {
  assert.equal(workspaceLabel(record('a', {}, { workspaceName: 'perso', cwd: '/x/y' })), 'perso')
  assert.equal(workspaceLabel(record('a', {}, { cwd: '/Users/me/repo/' })), 'repo')
  assert.equal(workspaceLabel(record('a', {})), 'Unknown')
})

test('totals, bars and breakdowns per period', () => {
  const history = {
    a: record('a', { '2026-11-20': 40, '2026-11-01': 10 }, { workspaceName: 'perso' }),
    b: record('b', { '2026-11-19': 20 }, { cwd: '/w/site' }),
    c: record('c', { '2025-06-01': 5 }, { cwd: '/w/site' })
  }
  const view = insights(history, '2026-11-20')
  assert.equal(view.sessionMedian, 20)
  assert.equal(view.dayMedian, 15)
  const week = view.periods['7']
  assert.equal(week.days.length, 7)
  assert.equal(week.co2Grams, 60)
  assert.equal(week.sessions, 2)
  assert.deepEqual(week.byWorkspace.map((s) => [s.name, s.co2Grams]), [['perso', 40], ['site', 20]])
  // a has 40 of its 50 g in the week: 80 % of each model's share.
  assert.deepEqual(week.byModel.map((s) => [s.name, Math.round(s.co2Grams)]), [
    ['claude-opus-5-5', 45],
    ['claude-haiku-4-5', 15]
  ])
  assert.equal(week.days[6].cls, classOf(40, 15))
  assert.equal(week.days[0].cls, null)
  assert.equal(view.periods['30'].co2Grams, 70)
  const all = view.periods.all
  assert.equal(all.days[0].day, '2025-06-01')
  assert.equal(all.co2Grams, 75)
  assert.equal(all.sessions, 3)
})

test('folds the smaller slices into Other', () => {
  const history = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`s${i}`, record(`s${i}`, { '2026-11-20': i + 1 }, { workspaceName: `w${i}` })])
  )
  const names = insights(history, '2026-11-20').periods['7'].byWorkspace.map((s) => s.name)
  assert.deepEqual(names, ['w7', 'w6', 'w5', 'w4', 'w3', 'Other (3)'])
})
