import { assert, test } from 'orca/testing'
import { focusOf, lastDays, summarize, upsert, type SessionRecord } from './history.ts'

const tokens = { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }

function record(
  sessionId: string,
  updatedAt: number,
  days: Record<string, number>,
  title: string | null = null
): SessionRecord {
  const total = Object.values(days).reduce((a, b) => a + b, 0)
  return {
    sessionId,
    title,
    updatedAt,
    stamp: '',
    co2Grams: total,
    costUsd: total / 100,
    tokens,
    models: [],
    days: Object.fromEntries(
      Object.entries(days).map(([day, g]) => [day, { co2Grams: g, costUsd: g / 100 }])
    )
  }
}

test('storing a session again replaces it and keeps its title', () => {
  let history = upsert({}, record('s1', 1, { '2026-11-20': 5 }, 'Fix the build'))
  history = upsert(history, record('s1', 2, { '2026-11-20': 8 }))
  assert.deepEqual(Object.keys(history), ['s1'])
  assert.equal(history.s1.co2Grams, 8)
  assert.equal(history.s1.title, 'Fix the build')
})

test('lastDays crosses months', () => {
  assert.deepEqual(lastDays('2026-03-01', 3), ['2026-02-27', '2026-02-28', '2026-03-01'])
})

test('summarizes the latest session, today and the last 30 days', () => {
  const history = {
    old: record('old', 1, { '2026-09-01': 100 }),
    a: record('a', 2, { '2026-11-19': 3, '2026-11-20': 2 }),
    b: record('b', 3, { '2026-11-20': 4 })
  }
  const s = summarize(history, '2026-11-20')
  assert.equal(s.latest?.sessionId, 'b')
  assert.equal(s.todayTotal.co2Grams, 6)
  assert.equal(s.todayTotal.sessions, 2)
  assert.equal(s.last30.co2Grams, 9)
  assert.equal(s.last30.sessions, 2)
  assert.equal(s.days.length, 30)
  assert.equal(s.days[29].day, '2026-11-20')
})

test('lists a workspace session by its ids or because Orca runs it there, picked one first', () => {
  const a = { ...record('a', 1, { '2026-11-20': 1 }, 'Chat A'), workspaceIds: ['w1'], lastActiveAt: 5 }
  const b = { ...record('b', 2, { '2026-11-20': 1 }), workspaceIds: ['w2'], lastActiveAt: 9, startedAt: null }
  const c = { ...record('c', 3, { '2026-11-20': 1 }), workspaceIds: ['w2'], lastActiveAt: 1 }
  const history = { a, b, c }
  const ws = { ids: ['w1'], name: 'perso', workspaceId: 'w1' }
  const focus = focusOf(history, ws, { b: 'Live B' }, {})
  assert.deepEqual(focus.sessions.map((s) => [s.sessionId, s.label]), [
    ['b', 'Live B'],
    ['a', 'Chat A']
  ])
  assert.equal(focus.selected, 'b')
  assert.equal(focusOf(history, ws, { b: null }, { w1: 'a' }).selected, 'a')
  // A pick for a session no longer there falls back to the most recently active.
  assert.equal(focusOf(history, ws, {}, { w1: 'gone' }).selected, 'a')
  assert.equal(focusOf({}, ws, {}, {}).selected, null)
})
