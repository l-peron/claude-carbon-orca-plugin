// The ported math against claude-carbon's own golden vectors (tests/ at the repository
// root) and data/factors.json and prices.json, and the transcript parsing.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { co2Grams, isExcluded, parseFactors } from './co2.ts'
import { costUsd, parsePrices } from './cost.ts'
import { sessionTotals } from './session.ts'
import { mergeRows, parseTranscript } from './transcript.ts'

const here = dirname(fileURLToPath(import.meta.url))
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'))

function close(actual: number, expected: number, name: string): void {
  const ok =
    expected === 0
      ? Math.abs(actual) <= 1e-6
      : Math.abs(actual - expected) / Math.abs(expected) <= 1e-6
  assert.ok(ok, `${name}: expected ${expected}, got ${actual}`)
}

test('matches every claude-carbon golden vector', async () => {
  const factors = parseFactors(await json(join(here, '../../../data/factors.json')))
  const pricesRaw = await json(join(here, '../../../data/prices.json'))
  const prices = parsePrices(pricesRaw)!
  // The family vectors pin the family prices, without model_overrides, as upstream replays them.
  const familyPrices = parsePrices({ ...pricesRaw, model_overrides: undefined })!
  let checked = 0
  for (const [file, vectorPrices] of [
    ['methodology-vectors.json', familyPrices],
    ['methodology-vectors-per-model.json', prices]
  ] as const) {
    const { vectors } = await json(join(here, '../../../tests', file))
    for (const v of vectors) {
      const usage = {
        input_tokens: v.input_tokens,
        cache_creation_input_tokens: v.cache_creation_tokens,
        cache_read_input_tokens: v.cache_read_tokens,
        output_tokens: v.output_tokens
      }
      const excluded = isExcluded(v.model, factors.excludeModels)
      if (v.expected_co2_grams === null) {
        assert.equal(excluded, true, `${v.id} excluded`)
        continue
      }
      assert.equal(excluded, false, `${v.id} counted`)
      close(co2Grams(usage, v.model, factors), v.expected_co2_grams, v.id)
      close(
        costUsd(usage, v.model, vectorPrices, v.cache_creation_1h_tokens ?? 0),
        v.expected_cost_usd,
        `${v.id} cost`
      )
      checked += 1
    }
  }
  assert.ok(checked > 10, `only ${checked} vectors`)
})

const line = (o: object) => JSON.stringify(o)
const assistant = (id: string, model: string, ts: string, usage: object) =>
  line({ type: 'assistant', requestId: `r-${id}`, timestamp: ts, message: { id, model, usage } })

test('sums usage per model and day, keeping the last snapshot of a message', () => {
  const text = [
    line({ type: 'user', message: { content: 'hi' } }),
    assistant('a', 'claude-opus-5-5', '2026-11-20T10:00:00', { input_tokens: 10, output_tokens: 1 }),
    // A later streaming snapshot of the same message: it replaces the first.
    assistant('a', 'claude-opus-5-5', '2026-11-20T10:00:01', {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 60 },
      cache_read_input_tokens: 1000,
      output_tokens: 50
    }),
    assistant('b', 'claude-haiku-4-5', '2026-11-20T11:00:00', { input_tokens: 5, output_tokens: 5 }),
    '{"type":"assistant", half a line',
    assistant('c', 'claude-opus-5-5', '2026-11-21T09:00:00', { input_tokens: 1, output_tokens: 2 })
  ].join('\n')
  const rows = parseTranscript(text, '2000-01-01', (ts) => ts.slice(0, 10))
  assert.deepEqual(rows, [
    {
      model: 'claude-opus-5-5',
      day: '2026-11-20',
      tokens: { input: 10, cacheWrite: 100, cacheWrite1h: 60, cacheRead: 1000, output: 50 }
    },
    {
      model: 'claude-haiku-4-5',
      day: '2026-11-20',
      tokens: { input: 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 }
    },
    {
      model: 'claude-opus-5-5',
      day: '2026-11-21',
      tokens: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 2 }
    }
  ])
})

test('gives a message with no model the dominant one, and no timestamp the fallback day', () => {
  const text = [
    assistant('a', 'claude-sonnet-4-6', '2026-11-20T10:00:00', { output_tokens: 1 }),
    assistant('b', 'claude-sonnet-4-6', '2026-11-20T10:00:00', { output_tokens: 1 }),
    line({ type: 'assistant', message: { usage: { output_tokens: 7 } } })
  ].join('\n')
  const rows = parseTranscript(text, '2026-11-19', (ts) => ts.slice(0, 10))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1], {
    model: 'claude-sonnet-4-6',
    day: '2026-11-19',
    tokens: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 7 }
  })
})

test('prices a session per model and day, counting non-Claude models as zero', () => {
  const factors = parseFactors({})
  const prices = parsePrices({})!
  const rows = mergeRows([
    { model: 'claude-opus-5-5', day: 'd1', tokens: { input: 1000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1000 } },
    { model: 'claude-opus-5-5', day: 'd1', tokens: { input: 1000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 } },
    { model: 'llama-local', day: 'd2', tokens: { input: 5000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 5000 } }
  ])
  const totals = sessionTotals(rows, factors, prices)
  // Opus defaults: 78 g/M input, 1652 g/M output; $4/M input, $20/M output.
  close(totals.co2Grams, (2000 * 78 + 1000 * 1652) / 1e6, 'co2')
  close(totals.costUsd, (2000 * 4 + 1000 * 20) / 1e6, 'cost')
  assert.deepEqual(Object.keys(totals.days).sort(), ['d1', 'd2'])
  assert.equal(totals.days.d2.co2Grams, 0)
  assert.deepEqual(
    totals.models.map((m) => [m.model, m.excluded]),
    [
      ['claude-opus-5-5', false],
      ['llama-local', true]
    ]
  )
})
