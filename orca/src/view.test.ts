// The panel's HTML in each state, as src/panel.ts puts it on the page.
import { assert, test } from 'orca/testing'
import { focusOf, summarize, type History, type SessionRecord } from './history.ts'
import { insights } from './insights.ts'
import type { BackfillState, CarbonState } from './protocol.ts'
import { carFactor, carFor, currentHtml, esc, historyHtml, pageHtml, yTicks } from './view.ts'

const TODAY = '2026-11-20'
const now = Date.now()
const cars = {
  fr: { divisor: 142, unit: 'km', label: 'km en voiture', tag: '142 g/km, ADEME 2025' },
  world: { divisor: 200, unit: 'km', label: 'km driven by car', tag: '200 g/km, world avg' }
}
const idle: BackfillState = { running: false, done: 0, total: 0, imported: 0, finishedAt: now - 120_000 }

const record = (id: string, title: string | null, grams: number, at: number): SessionRecord => ({
  sessionId: id,
  title,
  updatedAt: now,
  stamp: '',
  workspaceIds: ['w1'],
  startedAt: at,
  lastActiveAt: at,
  co2Grams: grams,
  costUsd: grams / 10,
  tokens: { input: 1200, cacheWrite: 50000, cacheWrite1h: 50000, cacheRead: 1234567, output: 3400 },
  models: [{ model: 'claude-opus-5-5', co2Grams: grams, costUsd: grams / 10, excluded: false }],
  days: { [TODAY]: { co2Grams: grams, costUsd: grams / 10 } }
})

function state(history: History, focus: 'none' | 'w1' | 'w9' = 'w1', backfill = idle): CarbonState {
  return {
    ...summarize(history, TODAY),
    dataSource: '/plugin/data',
    focus:
      focus === 'none'
        ? null
        : focusOf(history, { ids: [focus], name: focus === 'w1' ? 'perso' : 'site', workspaceId: focus }, {}, {}),
    insights: insights(history, TODAY),
    cars,
    envSet: null,
    backfill
  }
}

const opts = { period: '30' as const, now, locale: 'en-US' }
const many: History = {
  a: record('a', 'Port <b>carbon</b>', 126, now - 1000),
  b: record('b', null, 20, now - 5000),
  c: record('c', 'Other', 10, now - 9000)
}

test('escapes text from transcripts and Orca', () => {
  assert.equal(esc(`<img src=x onerror="a">'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;')
  const html = pageHtml(state(many), opts)
  assert.ok(!html.includes('<b>carbon</b>'))
  assert.ok(html.includes('Port &lt;b&gt;carbon&lt;/b&gt;'))
})

test('the current session: big number, cost, car, one median line, tokens, picker', () => {
  const html = currentHtml(state(many), opts)
  assert.match(html, /Current session/)
  assert.match(html, /class="where" title="perso"/)
  assert.match(html, /<span class="big">126<\/span>\u00a0<span class="unit">gCO₂e<\/span>/)
  assert.match(html, /\$12\.60/)
  // 126 g is 6.3 times the 20 g median: above it, so the accent dot shows.
  assert.match(html, /<p class="versus"><span class="dot" aria-hidden="true"><\/span>6\.3× your median session \(20\.0\u00a0gCO₂e\)<\/p>/)
  assert.ok(!/#[0-9a-f]{6}/i.test(html), 'no fixed colour')
  assert.match(html, /0\.63\u00a0km driven by car<\/strong> <span class="muted">\(200\u00a0gCO₂e\/km, world avg\)/)
  assert.match(html, /<th scope="row">Cache read<\/th><td>1,234,567<\/td>/)
  assert.match(html, /<select data-action="pick"/)
  assert.match(html, /<option value="a" selected>/)
  assert.match(html, /Updated less than a minute ago/)
})

test('a French Orca gets the French car, the locale wins over it', () => {
  assert.equal(carFor(cars, null, 'fr-FR')?.label, 'km en voiture')
  assert.equal(carFor(cars, 'world', 'fr-FR')?.label, 'km driven by car')
  assert.equal(carFor({}, null, 'en'), null)
})

test('one session: no picker and no median line yet; below the median, no dot', () => {
  const html = currentHtml(state({ a: many.a }), opts)
  assert.ok(!html.includes('data-action="pick"'))
  assert.ok(!html.includes('class="versus"'))
  const picked = currentHtml(
    { ...state(many), focus: { ...state(many).focus!, selected: 'c' } },
    opts
  )
  assert.match(picked, /<p class="versus">0\.5× your median session/)
  assert.ok(!picked.includes('class="dot"'))
})

test('no session in the workspace, and no workspace', () => {
  const none = currentHtml(state(many, 'w9'), opts)
  assert.match(none, /No Claude Code session in this workspace\./)
  assert.ok(!none.includes('class="hero"'))
  assert.match(currentHtml(state(many, 'none'), opts), /Open a workspace in Orca/)
})

test('history: periods, totals, bars with a Y axis, breakdowns and the import button', () => {
  const html = historyHtml(state(many), { ...opts, period: '7' })
  assert.match(html, /data-period="7" class="on" aria-pressed="true"/)
  assert.match(html, /<span class="kpi">156<\/span>\u00a0<span class="unit">gCO₂e<\/span>/)
  assert.match(html, /<span class="kpi">3<\/span>/)
  // A hover target per day, a bar for the one day with CO2, today's marked.
  assert.equal((html.match(/class="hit"/g) ?? []).length, 7)
  assert.equal((html.match(/class="bar"/g) ?? []).length, 1)
  assert.match(html, /<g class="day today"><title>2026-11-20: 156\u00a0gCO₂e · \$15\.60<\/title>/)
  assert.ok(!html.includes('stripes'))
  assert.match(html, /<div class="y-labels" aria-hidden="true"><span style="bottom:0\.00%">0\u00a0gCO₂e<\/span>/)
  assert.match(html, /<span style="bottom:50\.00%">100\u00a0gCO₂e<\/span><span style="bottom:100\.00%">200\u00a0gCO₂e<\/span>/)
  assert.ok(!/#[0-9a-f]{6}/i.test(html), 'no fixed colour')
  assert.match(html, /By model/)
  assert.match(html, /By workspace/)
  assert.match(html, /data-action="reimport"/)
  assert.match(html, /Imported 2 min ago/)
})

test('history while the import runs, and when it is empty', () => {
  const running = { running: true, done: 34, total: 142, imported: 30, finishedAt: null }
  const html = historyHtml(state({}, 'w1', running), opts)
  assert.match(html, /Importing history…/)
  assert.match(html, /34 \/ 142/)
  assert.ok(!html.includes('data-action="reimport"'))
  assert.ok(!html.includes('By model'))
})

test('Y ticks: round steps in gCO₂e or kgCO₂e', () => {
  const labels = (max: number) => yTicks(max).ticks.map((t) => t.label.replace(/\u00a0/g, ' '))
  assert.deepEqual(yTicks(0).top, 1)
  assert.deepEqual(labels(0), ['0 gCO₂e'])
  assert.deepEqual(labels(156), ['0 gCO₂e', '100 gCO₂e', '200 gCO₂e'])
  assert.deepEqual(labels(2900), ['0 kgCO₂e', '1 kgCO₂e', '2 kgCO₂e', '3 kgCO₂e'])
  assert.equal(yTicks(2900).top, 3000)
  assert.deepEqual(labels(7.5), ['0 gCO₂e', '2.5 gCO₂e', '5 gCO₂e', '7.5 gCO₂e'])
})

test('every CO₂ value has its full unit, joined by a non-breaking space', () => {
  const running = { running: true, done: 3, total: 9, imported: 1, finishedAt: null }
  const pages = [
    pageHtml(state(many), opts),
    pageHtml(state(many), { ...opts, period: 'all' }),
    pageHtml(state({ a: many.a }), opts),
    pageHtml(state(many, 'w9', running), opts),
    pageHtml(state({ big: record('big', 'Big', 2_900_000, now) }), { ...opts, period: '7' })
  ]
  for (const html of pages) {
    // Text as a person reads it, tooltips and labels included.
    const text = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ')
    const attrs = [...html.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]).join(' ')
    const all = `${text} ${attrs}`
    // What precedes a bare unit, so a failure says where it is.
    const rest = all.replace(/k?gCO₂e/g, 'X')
    const bare = /\d\s?k?g(?![a-zA-Z₂])/.exec(rest)
    assert.equal(bare && rest.slice(bare.index - 30, bare.index + 10), null, 'a bare g or kg')
    assert.ok(!/\d[ \t\n]k?gCO₂e/.test(all), 'a plain space before a CO₂ unit')
    assert.ok(!/(^|[^k])\bCO2/.test(all), 'CO2 without the subscript')
    assert.ok(!/\d g\b/.test(html) && !/\d kg\b/.test(html))
  }
  // The car factor in full units.
  assert.equal(carFactor(cars.fr), '142\u00a0gCO₂e/km, ADEME 2025')
})
