// Writes the README screenshots' pages: the panel's own HTML (src/view.ts) over made-up
// sessions, with Orca's default light and dark theme colours standing in for its
// --orca-* variables. No real transcript or workspace name goes in.
//
//   node --experimental-strip-types orca/docs/render-shots.mts <out-dir>
//   then open each <out-dir>/*.html in a browser at 360 px wide and capture it (the README's
//   PNGs come from headless Chrome: --screenshot --window-size=360,<height>).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFactors } from '../src/carbon/co2.ts'
import { parsePrices } from '../src/carbon/cost.ts'
import type { Tokens } from '../src/carbon/transcript.ts'
import { price, type History, type SessionRecord } from '../src/history.ts'
import { insights } from '../src/insights.ts'
import { focusOf } from '../src/workspaces.ts'
import type { CarbonState } from '../src/protocol.ts'
import { currentHtml, historyHtml, pageHtml, STYLES } from '../src/view.ts'

const out = process.argv[2] ?? '.'
const TODAY = new Date(2026, 10, 20)
const day = (offset: number) => {
  const d = new Date(TODAY)
  d.setDate(d.getDate() - offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// A small deterministic generator, so the pictures do not change from run to run.
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

const WORKSPACES = ['my-app', 'website', 'api-server', 'docs', 'cli-tool', 'design-system', 'infra']
const TITLES = ['Fix login redirect', 'Add dark mode', 'Refactor API client', 'Write release notes', 'Speed up tests']

const factors = parseFactors({})
const prices = parsePrices({})
const tokens = (output: number, extra: Partial<Tokens> = {}): Tokens => ({
  input: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output,
  ...extra
})

const history: History = {}
let n = 0
for (let offset = 29; offset >= 0; offset--) {
  const weekend = [0, 6].includes(new Date(day(offset)).getDay())
  const count = weekend ? Math.floor(rand() * 2) : 1 + Math.floor(rand() * 5)
  for (let i = 0; i < count; i++) {
    const grams = 40 + rand() ** 2 * 1200
    const id = `s${n++}`
    const opus = 0.85 + rand() * 0.1
    const at = Date.now() - offset * 86_400_000
    history[id] = {
      sessionId: id,
      title: TITLES[n % TITLES.length],
      updatedAt: at,
      stamp: '',
      workspaceIds: [],
      workspaceName: WORKSPACES[Math.floor(rand() ** 1.6 * WORKSPACES.length)],
      cwd: null,
      startedAt: at - 3_600_000,
      lastActiveAt: at,
      // Output tokens that give `grams` at the default factors (Opus 1652, Haiku 207 g/M).
      usage: [
        { model: 'claude-opus-5-5', day: day(offset), tokens: tokens((grams * opus * 1e6) / 1652) },
        { model: 'claude-haiku-5-5', day: day(offset), tokens: tokens((grams * (1 - opus) * 1e6) / 207) }
      ]
    }
  }
}

// The focused workspace: two sessions today, the latest one shown.
const current = (id: string, title: string, output: number, minutesAgo: number): SessionRecord => ({
  ...history.s0,
  sessionId: id,
  title,
  workspaceIds: ['w1'],
  workspaceName: 'my-app',
  updatedAt: Date.now() - 40_000,
  startedAt: Date.now() - minutesAgo * 60_000,
  lastActiveAt: Date.now() - minutesAgo * 30_000,
  usage: [
    {
      model: 'claude-opus-5-5',
      day: day(0),
      tokens: tokens(output, { input: 196, cacheWrite: 237_661, cacheWrite1h: 237_661, cacheRead: 19_976_690 })
    }
  ]
})
history.now1 = current('now1', 'Add dark mode', 32_248, 50)
history.now2 = current('now2', 'Fix login redirect', 12_000, 180)

const sessions = Object.values(history).map((r) => price(r, factors, prices))
const state: CarbonState = {
  today: day(0),
  dataSource: 'data',
  focus: focusOf(sessions, { workspaceId: 'w1', name: 'my-app' }, [], {}, {}),
  insights: insights(sessions, day(0), []),
  cars: { world: { divisor: 200, unit: 'km', label: 'km driven by car', tag: '200 g/km, world avg' } },
  envSet: 'world',
  backfill: { running: false, done: 0, total: 0, imported: 0, finishedAt: Date.now() - 600_000 },
  live: true
}

const THEMES = {
  light: `--orca-background:#ffffff;--orca-foreground:#0a0a0a;--orca-card:#ffffff;--orca-card-foreground:#0a0a0a;
    --orca-primary:#171717;--orca-primary-foreground:#fafafa;--orca-secondary:#f5f5f5;--orca-secondary-foreground:#171717;
    --orca-muted:#f5f5f5;--orca-muted-foreground:#737373;--orca-accent:#f5f5f5;--orca-accent-foreground:#171717;
    --orca-border:#e5e5e5;--orca-input:#e5e5e5;--orca-ring:#a3a3a3;--orca-radius:10px;`,
  dark: `--orca-background:#0a0a0a;--orca-foreground:#fafafa;--orca-card:#171717;--orca-card-foreground:#fafafa;
    --orca-primary:#e5e5e5;--orca-primary-foreground:#171717;--orca-secondary:#262626;--orca-secondary-foreground:#fafafa;
    --orca-muted:#262626;--orca-muted-foreground:#a3a3a3;--orca-accent:#262626;--orca-accent-foreground:#fafafa;
    --orca-border:#2e2e2e;--orca-input:#3a3a3a;--orca-ring:#737373;--orca-radius:10px;`
}

const page = (body: string, theme: keyof typeof THEMES) =>
  `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><style>:root{${THEMES[theme]}--orca-font-sans:-apple-system,system-ui,sans-serif}${STYLES}body{width:360px}</style></head><body>${body}</body></html>`

const opts = { period: '30' as const, now: Date.now(), locale: 'en-US' }
writeFileSync(join(out, 'current-session.html'), page(currentHtml(state, opts), 'light'))
writeFileSync(join(out, 'history.html'), page(historyHtml(state, opts), 'light'))
writeFileSync(join(out, 'panel-dark.html'), page(pageHtml(state, opts), 'dark'))
console.log(`wrote 3 pages to ${out}`)
