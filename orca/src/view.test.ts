// What the panel shows in each state, read as a person reads it: the text and the controls.
import { assert, test } from 'orca/testing'
import { parseFactors } from './carbon/co2.ts'
import { parsePrices } from './carbon/cost.ts'
import { record } from './fixtures.ts'
import { price, type Priced } from './history.ts'
import { insights } from './insights.ts'
import type { BackfillState, CarbonState } from './protocol.ts'
import { carFactor, carFor, currentHtml, esc, historyHtml, pageHtml, yTicks } from './view.ts'
import { focusOf } from './workspaces.ts'

const TODAY = '2026-11-20'
const now = Date.now()
const cars = {
  fr: { divisor: 142, unit: 'km', label: 'km en voiture', tag: '142 g/km, ADEME 2025' },
  world: { divisor: 200, unit: 'km', label: 'km driven by car', tag: '200 g/km, world avg' }
}
const idle: BackfillState = { running: false, done: 0, total: 0, imported: 0, finishedAt: now - 120_000 }
const factors = parseFactors({})
const prices = parsePrices({})

/** A session of `grams` gCO2e today, Opus output only, in workspace w1. */
function session(id: string, title: string | null, grams: number, at: number): Priced {
  const tokens = { input: 1200, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 1234567, output: 0 }
  // Output tokens that bring the session to `grams` with Opus's default factors.
  const base = (1200 * 78 + 1234567 * 78 * 0.08) / 1e6
  tokens.output = ((grams - base) * 1e6) / 1652
  const usage = [{ model: 'claude-opus-5-5', day: TODAY, tokens }]
  return price(record(id, { title, usage, workspaceIds: ['w1'], lastActiveAt: at, updatedAt: now }), factors, prices)
}

function state(sessions: Priced[], focus: 'none' | 'w1' | 'w9' = 'w1', backfill = idle, live = true): CarbonState {
  return {
    today: TODAY,
    dataSource: '/plugin/data',
    focus: focus === 'none' ? null : focusOf(sessions, { workspaceId: focus, name: focus === 'w1' ? 'perso' : 'site' }, [], {}, {}),
    insights: insights(sessions, TODAY, []),
    cars,
    envSet: null,
    backfill,
    live
  }
}

/** The page as text, tooltips and labels included, with plain spaces. */
function text(html: string): string {
  const attrs = [...html.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]).join(' ')
  return `${html.replace(/<title>[^<]*<\/title>/g, ' ').replace(/<[^>]*>/g, ' ')} ${attrs}`
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
}

const opts = { period: '30' as const, now, locale: 'en-US' }
const others = Array.from({ length: 10 }, (_, i) => session(`o${i}`, `Other ${i}`, 20, now - 60_000 * (i + 10)))
const many = [session('a', 'Port <b>carbon</b>', 126, now - 1000), ...others]

test('escapes text from transcripts and Orca', () => {
  assert.equal(esc(`<img src=x onerror="a">'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;')
  const html = pageHtml(state(many), opts)
  assert.ok(!html.includes('<b>carbon</b>'))
  assert.ok(text(html).includes('Port <b>carbon</b>'))
})

test('the current session: CO₂, cost, car, the median line, tokens and the picker', () => {
  const page = text(currentHtml(state(many), opts))
  assert.ok(page.includes('Current session perso'))
  assert.ok(page.includes('126 gCO₂e'))
  assert.ok(page.includes('API-equivalent'))
  assert.ok(page.includes('0.63 km driven by car'))
  assert.ok(page.includes('(200 gCO₂e/km, world avg)'))
  // 126 g against the median of the 10 other sessions, 20 g, worded as claude-carbon does.
  assert.ok(page.includes('6.3× your median (20.0 gCO₂e)'))
  assert.ok(page.includes('Cache read 1,234,567'))
  assert.ok(page.includes('Updated less than a minute ago'))
  const html = currentHtml(state(many), opts)
  assert.match(html, /<select data-action="pick"/)
  assert.match(html, /<option value="a" selected>/)
  assert.ok(!/#[0-9a-f]{6}/i.test(html), 'no fixed colour')
})

test('a French Orca gets the French car, the locale wins over it', () => {
  assert.equal(carFor(cars, null, 'fr-FR')?.label, 'km en voiture')
  assert.equal(carFor(cars, 'world', 'fr-FR')?.label, 'km driven by car')
  assert.equal(carFor({}, null, 'en'), null)
})

test('fewer than 10 other sessions: no median line; one session: no picker', () => {
  const few = currentHtml(state(many.slice(0, 5)), opts)
  assert.ok(!text(few).includes('median'))
  assert.ok(!currentHtml(state(many.slice(0, 1)), opts).includes('data-action="pick"'))
})

test('no session in the workspace, and no workspace', () => {
  assert.ok(text(currentHtml(state(many, 'w9'), opts)).includes('No Claude Code session in this workspace.'))
  assert.ok(text(currentHtml(state(many, 'none'), opts)).includes('Open a workspace in Orca'))
})

test('history: periods, totals, a bar per day with a Y axis, breakdowns, the import', () => {
  const html = historyHtml(state(many), { ...opts, period: '7' })
  const page = text(html)
  assert.match(html, /data-period="7" class="on" aria-pressed="true"/)
  assert.ok(page.includes('326 gCO₂e emissions'))
  assert.ok(page.includes('11 sessions'))
  assert.equal((html.match(/class="hit"/g) ?? []).length, 7)
  assert.equal((html.match(/class="bar"/g) ?? []).length, 1)
  assert.ok(html.includes(`<title>${TODAY}: 326 gCO₂e`))
  assert.ok(page.includes('0 gCO₂e 200 gCO₂e 400 gCO₂e'), 'Y axis labels')
  assert.ok(page.includes('By model claude-opus-5-5'))
  assert.ok(page.includes('By workspace'))
  assert.ok(page.includes('Imported 2 min ago'))
  assert.match(html, /data-action="reimport"/)
})

test('history while the import runs, and when it is empty', () => {
  const running = { running: true, done: 34, total: 142, imported: 30, finishedAt: null }
  const html = historyHtml(state([], 'w1', running), opts)
  assert.ok(text(html).includes('Importing history… 34 / 142'))
  assert.ok(!html.includes('data-action="reimport"'))
  assert.ok(!text(html).includes('By model'))
})

test('an Orca that does not name sessions says so', () => {
  assert.ok(text(pageHtml(state(many, 'w1', idle, false), opts)).includes('host API 1.8'))
  assert.ok(!text(pageHtml(state(many), opts)).includes('host API 1.8'))
})

test('Y ticks: round steps in gCO₂e or kgCO₂e', () => {
  const labels = (max: number) => yTicks(max).ticks.map((t) => t.label.replace(/ /g, ' '))
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
    pageHtml(state(many.slice(0, 1)), opts),
    pageHtml(state(many, 'w9', running), opts),
    pageHtml(state([session('big', 'Big', 2_900_000, now)]), { ...opts, period: '7' })
  ]
  for (const html of pages) {
    const all = text(html.replace(/<title>/g, ' ').replace(/<\/title>/g, ' ')).replace(/ /g, ' ')
    const rest = all.replace(/k?gCO₂e/g, 'X')
    const bare = /\d\s?k?g(?![a-zA-Z₂])/.exec(rest)
    assert.equal(bare && rest.slice(bare.index - 30, bare.index + 10), null, 'a bare g or kg')
    assert.ok(!/(^|[^k])\bCO2/.test(all), 'CO2 without the subscript')
    // Between a number and its unit, only a non-breaking space.
    assert.ok(!/\d[ \t\n]k?gCO₂e/.test(html.replace(/<[^>]*>/g, '')), 'a plain space before a CO₂ unit')
  }
  assert.equal(carFactor(cars.fr), '142 gCO₂e/km, ADEME 2025')
})
