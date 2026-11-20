// The stored records: migration from the first schema, replacing, and pricing.
import { assert, test } from 'orca/testing'
import { parseFactors } from './carbon/co2.ts'
import { parsePrices } from './carbon/cost.ts'
import { opus, record } from './fixtures.ts'
import { latestOf, lastDays, migrate, price, SCHEMA_VERSION, upsert } from './history.ts'

test('a schema 1 history keeps names, workspaces and amounts, and is read again', () => {
  const v1 = {
    s1: {
      sessionId: 's1',
      title: 'Fix the build',
      updatedAt: 5,
      stamp: '1:10:5',
      workspaceIds: ['w1'],
      workspaceName: 'perso',
      cwd: '/x/repo',
      lastActiveAt: 4,
      co2Grams: 12,
      costUsd: 0.5,
      tokens: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 },
      models: [{ model: 'claude-opus-5-5', co2Grams: 12, costUsd: 0.5, excluded: false }],
      days: { '2026-11-19': { co2Grams: 12, costUsd: 0.5 } }
    },
    junk: 'not a record'
  }
  const history = migrate(v1, undefined)
  assert.deepEqual(Object.keys(history), ['s1'])
  const s1 = history.s1
  assert.equal(s1.stamp, '', 'never matches a stamp, so the next scan reads it again')
  assert.deepEqual([s1.title, s1.workspaceIds, s1.workspaceName, s1.cwd], ['Fix the build', ['w1'], 'perso', '/x/repo'])
  // Until then, or when its transcript is gone, it counts as it was stored.
  const priced = price(s1, parseFactors({}), parsePrices({}))
  assert.equal(priced.co2Grams, 12)
  assert.deepEqual(priced.days, { '2026-11-19': { co2Grams: 12, costUsd: 0.5 } })
  // The current schema reads back as written.
  const current = { s2: record('s2') }
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(current)), SCHEMA_VERSION), current)
  assert.deepEqual(migrate(null, undefined), {})
})

test('a record read from older files never replaces a newer one, and names are kept', () => {
  let history = upsert({}, record('s1', { lastActiveAt: 10, title: 'Fix the build', workspaceIds: ['w1'], usage: [opus(1, 2)] }))
  // An import that read the files before the last turn ended.
  history = upsert(history, record('s1', { lastActiveAt: 9, workspaceIds: ['w2'], usage: [opus(1, 1)] }))
  assert.deepEqual(history.s1.usage, [opus(1, 2)])
  assert.deepEqual(history.s1.workspaceIds, ['w1', 'w2'])
  history = upsert(history, record('s1', { lastActiveAt: 11, usage: [opus(1, 3)] }))
  assert.deepEqual(history.s1.usage, [opus(1, 3)])
  assert.equal(history.s1.title, 'Fix the build')
})

test('amounts follow the factors loaded now, and empty days drop out', () => {
  const r = record('s1', {
    usage: [opus(1000, 1000), { model: 'llama-local', day: '2026-11-18', tokens: opus(9, 9).tokens }]
  })
  const prices = parsePrices({})
  const before = price(r, parseFactors({ models: { opus: { input: 78, output: 1652 } } }), prices)
  const after = price(r, parseFactors({ models: { opus: { input: 100, output: 2000 } } }), prices)
  assert.ok(Math.abs(before.co2Grams - (1000 * 78 + 1000 * 1652) / 1e6) < 1e-9)
  assert.ok(Math.abs(after.co2Grams - (1000 * 100 + 1000 * 2000) / 1e6) < 1e-9)
  assert.deepEqual(Object.keys(after.days), ['2026-11-20'])
})

test('the latest session is the one active last, not the one computed last', () => {
  const factors = parseFactors({})
  const sessions = [
    record('recent', { lastActiveAt: 100, updatedAt: 1 }),
    record('old', { lastActiveAt: 5, updatedAt: 999 })
  ].map((r) => price(r, factors, null))
  assert.equal(latestOf(sessions)?.record.sessionId, 'recent')
  assert.equal(latestOf([]), null)
})

test('lastDays crosses months', () => {
  assert.deepEqual(lastDays('2026-03-01', 3), ['2026-02-27', '2026-02-28', '2026-03-01'])
})
