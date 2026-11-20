// The history per period, the workspaces sessions belong to, and the median.
import { assert, test } from 'orca/testing'
import { parseFactors } from './carbon/co2.ts'
import { parsePrices } from './carbon/cost.ts'
import { median, MIN_SESSIONS, pastSessions, ratioText, sessionMedian } from './carbon/median.ts'
import { price, type SessionRecord } from './history.ts'
import { record } from './fixtures.ts'
import { insights } from './insights.ts'
import { focusOf, workspaceLabel, workspaceOf, type Workspace } from './workspaces.ts'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const factors = parseFactors({})
const prices = parsePrices({})

/** A session of `grams` gCO2e (Opus output only) per day. */
function session(id: string, days: Record<string, number>, extra: Partial<SessionRecord> = {}) {
  const usage = Object.entries(days).map(([day, grams]) => ({
    model: 'claude-opus-5-5',
    day,
    tokens: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: (grams * 1e6) / 1652 }
  }))
  return price(record(id, { usage, ...extra }), factors, prices)
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

const WORKSPACES: Workspace[] = [
  { id: 'w1', name: 'perso', path: '/w/perso' },
  { id: 'w2', name: 'site', path: '/w/site' },
  { id: 'w3', name: 'site-docs', path: '/w/site/docs' }
]

test('a session belongs to the workspace Orca tied it to, else the deepest folder holding it', () => {
  assert.equal(workspaceOf({ workspaceIds: ['w1'], cwd: '/w/site' }, WORKSPACES)?.id, 'w1')
  assert.equal(workspaceOf({ workspaceIds: [], cwd: '/w/site/docs/api' }, WORKSPACES)?.id, 'w3')
  assert.equal(workspaceOf({ workspaceIds: [], cwd: '/w/sites' }, WORKSPACES), null)
  assert.equal(workspaceLabel({ workspaceIds: [], cwd: '/x/repo/', workspaceName: null }, []).name, 'repo')
  assert.equal(workspaceLabel({ workspaceIds: [], cwd: null, workspaceName: null }, []).name, 'Unknown')
})

test('totals, bars and breakdowns per period; one slice per workspace however it was seen', () => {
  const sessions = [
    // Seen in Orca with its id, and imported with only its folder: one workspace.
    session('a', { '2026-11-20': 40, '2026-11-01': 10 }, { workspaceIds: ['w1'] }),
    session('b', { '2026-11-19': 20 }, { cwd: '/w/perso/sub' }),
    session('c', { '2025-06-01': 5 }, { cwd: '/elsewhere/tool' })
  ]
  const view = insights(sessions, '2026-11-20', WORKSPACES)
  assert.ok(near(view.today.co2Grams, 40))
  assert.equal(view.today.sessions, 1)
  const week = view.periods['7']
  assert.equal(week.bar, 'day')
  assert.equal(week.bars.length, 7)
  assert.ok(near(week.co2Grams, 60))
  assert.equal(week.sessions, 2)
  assert.deepEqual([week.from, week.to], ['2026-11-14', '2026-11-20'])
  assert.deepEqual(week.byWorkspace.map((s) => s.name), ['perso'])
  assert.ok(near(view.periods['30'].co2Grams, 70))
  const all = view.periods.all
  assert.equal(all.bar, 'week', 'more than 120 days: a bar per week')
  assert.equal(all.from, '2025-06-01')
  assert.ok(near(all.bars.reduce((sum, b) => sum + b.co2Grams, 0), 75))
  assert.ok(near(all.bars[all.bars.length - 1].co2Grams, 60), 'the last week ends today')
  assert.deepEqual(all.byWorkspace.map((s) => s.name), ['perso', 'tool'])
})

test('a day with only excluded models is no session and starts no period', () => {
  const local = price(
    record('l', { usage: [{ model: 'llama-local', day: '2026-01-01', tokens: { input: 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 } }] }),
    factors,
    prices
  )
  const view = insights([local, session('a', { '2026-11-20': 1 })], '2026-11-20', [])
  assert.equal(view.periods.all.from, '2026-11-20')
  assert.equal(view.periods.all.sessions, 1)
})

test('folds the smaller slices into Other', () => {
  const sessions = Array.from({ length: 8 }, (_, i) =>
    session(`s${i}`, { '2026-11-20': i + 1 }, { workspaceName: `w${i}` })
  )
  const names = insights(sessions, '2026-11-20', []).periods['7'].byWorkspace.map((s) => s.name)
  assert.deepEqual(names, ['w7', 'w6', 'w5', 'w4', 'w3', 'Other (3)'])
})

// claude-carbon's mod code at the repository root sits outside the plugin, which tests may
// not import: its threshold is read from the source, its outputs pinned here.
const upstream = join(dirname(fileURLToPath(import.meta.url)), '../../hooks/mod/lib/sessions.ts')

test('the median and its ratio are claude-carbon’s', async () => {
  const source = await readFile(upstream, 'utf8')
  assert.equal(Number(/MIN_SESSIONS = (\d+)/.exec(source)?.[1]), MIN_SESSIONS)
  // format.ts median: every value, zeros included; 0 for none.
  assert.equal(median([]), 0)
  assert.equal(median([4, 1, 3, 2, 0]), 2)
  assert.equal(median([0, 0, 7, 1]), 0.5)
  // sessionMedian: the past sessions only, null under 10 or at 0.
  const rows = [126, ...Array(10).fill(20)].map((grams, i) => ({ id: `s${i}`, grams }))
  assert.equal(sessionMedian(pastSessions(rows, 's0')), 20)
  assert.equal(sessionMedian(pastSessions(rows.slice(0, 10), 's0')), null)
  assert.equal(sessionMedian(Array.from({ length: 10 }, () => ({ grams: 0 }))), null)
  // currentLine's ratio: whole from 10, one decimal from 1, else two.
  assert.deepEqual(
    [[126, 20], [10, 20], [450, 20], [1, 20]].map(([g, m]) => ratioText(g, m)),
    ['6.3', '0.50', '23', '0.05']
  )
})

test('the focused workspace lists its sessions, compares with all the others', () => {
  const sessions = [
    session('a', { '2026-11-20': 126 }, { workspaceIds: ['w1'], lastActiveAt: 9, title: 'Chat A' }),
    session('b', { '2026-11-20': 20 }, { cwd: '/w/perso', lastActiveAt: 5 }),
    session('live', { '2026-11-20': 1 }, { lastActiveAt: 1 }),
    ...Array.from({ length: 9 }, (_, i) => session(`o${i}`, { '2026-11-20': 20 }, { cwd: '/w/site' }))
  ]
  const focus = focusOf(sessions, { workspaceId: 'w1', name: 'perso' }, WORKSPACES, { live: 'Live chat' }, {})
  assert.deepEqual(focus.sessions.map((s) => [s.sessionId, s.title]), [
    ['a', 'Chat A'],
    ['b', null],
    ['live', 'Live chat']
  ])
  assert.equal(focus.selected, 'a')
  assert.ok(focus.median !== null && near(focus.median, 20), 'the 11 other sessions, not a itself')
  assert.equal(focusOf(sessions, { workspaceId: 'w1', name: 'perso' }, WORKSPACES, {}, { w1: 'b' }).selected, 'b')
  assert.equal(focusOf(sessions, { workspaceId: 'w1', name: 'perso' }, WORKSPACES, {}, { w1: 'gone' }).selected, 'a')
  // Fewer than 10 other sessions: no median yet.
  assert.equal(focusOf(sessions.slice(0, 5), { workspaceId: 'w1', name: 'perso' }, WORKSPACES, {}, {}).median, null)
})
