// The panel's HTML, as strings from the worker's state: the current session on top, the
// history below. Pure (no DOM), so Node tests it; src/panel.ts puts it on the page. Every
// text from a transcript or from Orca goes through esc().
import type { CarEquivalence } from './carbon/equiv.ts'
import { ratioText } from './carbon/median.ts'
import { ago, CO2_UNITS, co2Parts, formatCo2, formatCount, formatUsd, NBSP } from './format.ts'
import { PERIODS, type Bar, type Period, type PeriodView, type Slice } from './insights.ts'
import type { BackfillState, CarbonState, EquivalenceSet } from './protocol.ts'
import type { SessionView } from './workspaces.ts'

export type ViewOptions = { period: Period; now: number; locale: string }

export const UPSTREAM = 'https://github.com/gwittebolle/claude-carbon'

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PERIOD_LABELS: Record<Period, string> = { '7': '7 d', '30': '30 d', '90': '90 d', all: 'All' }

/** The car set: the locale's when it names one, else French for a French Orca, else world. */
export function carFor(
  cars: Partial<Record<EquivalenceSet, CarEquivalence>>,
  envSet: EquivalenceSet | null,
  locale: string
): CarEquivalence | null {
  const set = envSet ?? (locale.toLowerCase().startsWith('fr') ? 'fr' : 'world')
  return cars[set] ?? cars.world ?? null
}

/** "200 gCO₂e/km, world avg": the factor in full units, then the tag's source. */
export function carFactor(car: CarEquivalence): string {
  const source = car.tag.split(', ').slice(1).join(', ')
  return `${car.divisor}${NBSP}${CO2_UNITS.g}/${car.unit}${source ? `, ${source}` : ''}`
}

function distance(grams: number, car: CarEquivalence): string {
  const value = grams / car.divisor
  return value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2)
}

/** A CO2 amount with a large number and a smaller unit on the same baseline, never split. */
function co2Html(grams: number, numberClass: string): string {
  const { value, unit } = co2Parts(grams)
  return `<span class="amount"><span class="${numberClass}">${esc(value)}</span>${NBSP}<span class="unit">${esc(unit)}</span></span>`
}

function startLabel(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Started ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A session's name: its agent's title, else when it started, else its id's start. */
export function sessionLabel(s: SessionView): string {
  return s.title || (s.startedAt !== null ? startLabel(s.startedAt) : s.sessionId.slice(0, 8))
}

/** A time the panel redraws as "N min ago" on its own (src/panel.ts). */
function agoHtml(prefix: string, at: number, now: number): string {
  return `<span data-ago="${at}" data-prefix="${esc(prefix)}">${esc(prefix + ago(at, now))}</span>`
}

function tokensTable(s: SessionView): string {
  const rows: [string, number][] = [
    ['Input', s.tokens.input],
    ['Cache read', s.tokens.cacheRead],
    ['Cache write', s.tokens.cacheWrite],
    ['Output', s.tokens.output]
  ]
  return `<table class="tokens"><tbody>${rows
    .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${formatCount(v)}</td></tr>`)
    .join('')}</tbody></table>`
}

function picker(state: CarbonState): string {
  const focus = state.focus
  if (!focus || focus.sessions.length < 2) return ''
  const options = focus.sessions
    .map(
      (s) =>
        `<option value="${esc(s.sessionId)}"${s.sessionId === focus.selected ? ' selected' : ''}>${esc(sessionLabel(s))} · ${esc(formatCo2(s.co2Grams))}</option>`
    )
    .join('')
  return `<label class="picker"><span>Session</span><select data-action="pick" aria-label="Session">${options}</select></label>`
}

export function currentHtml(state: CarbonState, opts: ViewOptions): string {
  const focus = state.focus
  const head = (name: string) =>
    `<header class="section-head"><h2>Current session</h2><span class="where" title="${esc(name)}">${esc(name)}</span></header>`
  if (!focus) {
    return `<section class="current">${head('No workspace')}<p class="empty">Open a workspace in Orca to see its Claude Code session.</p></section>`
  }
  const session = focus.sessions.find((s) => s.sessionId === focus.selected)
  if (!session) {
    return `<section class="current">${head(focus.name)}<p class="empty">No Claude Code session in this workspace.</p></section>`
  }
  const median = focus.median
  const car = carFor(state.cars, state.envSet, opts.locale)
  // One neutral line, as claude-carbon words it; a dot in the accent colour only above the median.
  const versus =
    median === null || !(session.co2Grams > 0)
      ? ''
      : `<p class="versus">${session.co2Grams > median ? '<span class="dot" aria-hidden="true"></span>' : ''}${ratioText(session.co2Grams, median)}×${NBSP}your median (${esc(formatCo2(median))})</p>`
  const label = sessionLabel(session)
  const models = session.models
    .map(
      (m) =>
        `<li><span>${esc(m.model)}</span><span>${esc(formatCo2(m.co2Grams))} · ${esc(formatUsd(m.costUsd))}</span></li>`
    )
    .join('')
  return (
    `<section class="current">${head(focus.name)}${picker(state)}` +
    `<div class="hero">` +
    `<div class="co2">${co2Html(session.co2Grams, 'big')}</div>` +
    `<div class="cost"><span class="amount"><span class="usd">${esc(formatUsd(session.costUsd))}</span>${NBSP}<span class="unit">API-equivalent</span></span></div>` +
    `</div>` +
    (car
      ? `<p class="equiv">≈ <strong>${distance(session.co2Grams, car)}${NBSP}${esc(car.label)}</strong> <span class="muted">(${esc(carFactor(car))})</span></p>`
      : '') +
    versus +
    `<p class="session-title" title="${esc(label)}">${esc(label)}</p>` +
    `<div class="split">${tokensTable(session)}<ul class="models">${models}</ul></div>` +
    `<p class="muted small">${agoHtml('Updated ', session.updatedAt, opts.now)}</p>` +
    `</section>`
  )
}

/** Axis ticks for `max` grams: 0 and 2 to 4 round steps above, in gCO₂e or kgCO₂e. */
export function yTicks(max: number): { top: number; ticks: { grams: number; label: string }[] } {
  if (!(max > 0)) return { top: 1, ticks: [{ grams: 0, label: `0${NBSP}${CO2_UNITS.g}` }] }
  const kg = max >= 1000
  const unit = kg ? 1000 : 1
  const raw = max / unit / 3
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power
  const count = Math.max(2, Math.ceil(max / unit / step))
  const ticks = Array.from({ length: count + 1 }, (_, i) => {
    const value = Number((i * step).toFixed(6))
    return { grams: value * unit, label: `${value}${NBSP}${kg ? CO2_UNITS.kg : CO2_UNITS.g}` }
  })
  return { top: count * step * unit, ticks }
}

/**
 * A bar per day in the accent colour, today's stronger, over light gridlines; the Y labels
 * are HTML beside the drawing so they keep their shape when it stretches. Each day has a
 * full-height hover target whose tooltip gives its date, CO₂ and cost.
 */
function barsHtml(days: Bar[], unit: PeriodView['bar']): string {
  const n = Math.max(1, days.length)
  const width = 300
  const height = 80
  const w = width / n
  const { top, ticks } = yTicks(Math.max(...days.map((d) => d.co2Grams), 0))
  const y = (grams: number) => height - (grams / top) * height
  const grid = ticks
    .map((t) => `<line x1="0" x2="${width}" y1="${y(t.grams).toFixed(2)}" y2="${y(t.grams).toFixed(2)}" class="${t.grams === 0 ? 'axis' : 'grid'}"/>`)
    .join('')
  const gap = n > 60 ? 0 : Math.min(2, w * 0.2)
  const bars = days
    .map((d, i) => {
      const h = d.co2Grams > 0 ? Math.max(1.5, height - y(d.co2Grams)) : 0
      const x = i * w
      const when = unit === 'week' ? `Week of ${d.day}` : d.day
      const tip = `${when}: ${formatCo2(d.co2Grams)} · ${formatUsd(d.costUsd)}`
      // The last bar holds today.
      return (
        `<g class="day${i === n - 1 ? ' today' : ''}"><title>${esc(tip)}</title>` +
        `<rect class="hit" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${height}"/>` +
        (h > 0
          ? `<rect class="bar" x="${(x + gap / 2).toFixed(2)}" y="${(height - h).toFixed(2)}" width="${Math.max(0.5, w - gap).toFixed(2)}" height="${h.toFixed(2)}"/>`
          : '') +
        `</g>`
      )
    })
    .join('')
  const labels = ticks
    .map((t) => `<span style="bottom:${((t.grams / top) * 100).toFixed(2)}%">${esc(t.label)}</span>`)
    .join('')
  return (
    `<div class="chart"><div class="y-labels" aria-hidden="true">${labels}</div>` +
    `<svg class="bars" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="CO₂ per day">${grid}${bars}</svg></div>`
  )
}

function slicesHtml(title: string, slices: Slice[], total: number): string {
  if (slices.length === 0) return ''
  const rows = slices
    .map((s) => {
      const pct = total > 0 ? (s.co2Grams / total) * 100 : 0
      const other = s.name.startsWith('Other (')
      return (
        `<li><div class="slice-head"><span class="name" title="${esc(s.name)}">${esc(s.name)}</span>` +
        `<span class="nums">${esc(formatCo2(s.co2Grams))} · ${esc(formatUsd(s.costUsd))}</span></div>` +
        `<div class="track"><div class="fill${other ? ' other' : ''}" style="width:${pct.toFixed(1)}%"></div></div></li>`
      )
    })
    .join('')
  return `<div class="slices"><h3>${title}</h3><ul>${rows}</ul></div>`
}

function importHtml(b: BackfillState, now: number): string {
  if (b.running) {
    const pct = b.total > 0 ? (b.done / b.total) * 100 : 0
    return (
      `<div class="import running"><div class="import-head"><span>Importing history…</span><span>${b.done} / ${b.total || '?'}</span></div>` +
      `<div class="track"><div class="fill accent" style="width:${pct.toFixed(1)}%"></div></div></div>`
    )
  }
  const last = b.finishedAt === null ? esc('Never imported') : agoHtml('Imported ', b.finishedAt, now)
  return `<div class="import"><span class="muted small">${last}</span><button type="button" data-action="reimport">Re-import history</button></div>`
}

export function historyHtml(state: CarbonState, opts: ViewOptions): string {
  const view: PeriodView = state.insights.periods[opts.period]
  const tabs = PERIODS.map(
    (p) =>
      `<button type="button" data-action="period" data-period="${p}" class="${p === opts.period ? 'on' : ''}" aria-pressed="${p === opts.period}">${PERIOD_LABELS[p]}</button>`
  ).join('')
  return (
    `<section class="history"><header class="section-head"><h2>History</h2><div class="periods" role="group" aria-label="Period">${tabs}</div></header>` +
    `<div class="kpis">` +
    `<div>${co2Html(view.co2Grams, 'kpi')}<span class="muted small">emissions</span></div>` +
    `<div><span class="kpi">${esc(formatUsd(view.costUsd))}</span><span class="muted small">API-equivalent</span></div>` +
    `<div><span class="kpi">${view.sessions}</span><span class="muted small">sessions</span></div>` +
    `</div>` +
    `<div class="today muted small">Today ${esc(formatCo2(state.insights.today.co2Grams))} · ${esc(formatUsd(state.insights.today.costUsd))}</div>` +
    barsHtml(view.bars, view.bar) +
    `<div class="range muted small"><span>${esc(view.from)}</span><span>${esc(view.to)}${view.bar === 'week' ? ' · a bar per week' : ''}</span></div>` +
    slicesHtml('By model', view.byModel, view.co2Grams) +
    slicesHtml('By workspace', view.byWorkspace, view.co2Grams) +
    importHtml(state.backfill, opts.now) +
    `</section>`
  )
}

export function pageHtml(state: CarbonState, opts: ViewOptions): string {
  return (
    currentHtml(state, opts) +
    historyHtml(state, opts) +
    `<footer class="muted small">Estimates with the factors and API prices of <a href="${UPSTREAM}" data-action="upstream">claude-carbon</a> (MIT)${state.dataSource ? '' : ', built-in defaults'}. Cost is what the tokens would cost on the API.${state.live ? '' : ' This Orca does not say which session an agent runs (host API 1.8): sessions show after the next scan, every 15 min.'}</footer>`
  )
}

export const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
/* The one colour the panel uses for data, from Orca's theme. */
:root { --carbon-accent: var(--orca-primary); }
body { margin: 0; padding: 12px; font: 13px/1.4 var(--orca-font-sans, system-ui, sans-serif);
  color: var(--orca-foreground); background: var(--orca-background); }
h2 { margin: 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--orca-muted-foreground); font-weight: 600; }
h3 { margin: 12px 0 6px; font-size: 12px; font-weight: 600; }
p { margin: 6px 0; }
.muted { color: var(--orca-muted-foreground); }
.small { font-size: 11px; }
section { background: var(--orca-card); color: var(--orca-card-foreground);
  border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 8px); padding: 12px; margin-bottom: 12px; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.where { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.empty { color: var(--orca-muted-foreground); }
.picker { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
.picker select { flex: 1; min-width: 0; background: var(--orca-background); color: var(--orca-foreground);
  border: 1px solid var(--orca-input); border-radius: 6px; padding: 4px 6px; font: inherit; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.amount { display: inline-flex; align-items: baseline; white-space: nowrap; }
.big { font-size: 40px; line-height: 1; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.usd { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.unit { font-size: 11px; color: var(--orca-muted-foreground); }
.equiv { font-size: 13px; }
.versus { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--orca-muted-foreground); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--carbon-accent); flex: none; }
.session-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 300px) { .split { grid-template-columns: 1fr; } }
.tokens { border-collapse: collapse; width: 100%; font-size: 12px; }
.tokens th { text-align: left; font-weight: 400; color: var(--orca-muted-foreground); padding: 2px 0; }
.tokens td { text-align: right; font-variant-numeric: tabular-nums; padding: 2px 0; }
.tokens tr + tr { border-top: 1px solid var(--orca-border); }
.models { list-style: none; margin: 0; padding: 0; font-size: 12px; }
.models li { display: flex; flex-direction: column; padding: 2px 0; }
.models li span:last-child { color: var(--orca-muted-foreground); }
.periods { display: inline-flex; border: 1px solid var(--orca-border); border-radius: 6px; overflow: hidden; }
.periods button { background: transparent; color: var(--orca-foreground); border: 0; padding: 3px 8px; font: inherit; font-size: 11px; cursor: pointer; }
.periods button + button { border-left: 1px solid var(--orca-border); }
.periods button.on { background: var(--orca-accent); color: var(--orca-accent-foreground); font-weight: 600; }
.kpis { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; margin-bottom: 4px; }
.kpis > div { display: flex; flex-direction: column; }
.kpi { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.today { margin-bottom: 6px; }
.chart { position: relative; padding-left: 66px; margin-top: 8px; }
.y-labels { position: absolute; left: 0; top: 0; bottom: 0; width: 62px; }
.y-labels span { position: absolute; right: 0; transform: translateY(50%); font-size: 10px; line-height: 1;
  color: var(--orca-muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bars { display: block; width: 100%; height: 96px; overflow: visible; }
.bars .grid { stroke: var(--orca-border); stroke-width: 1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
.bars .axis { stroke: var(--orca-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.bars .hit { fill: transparent; }
.bars .bar { fill: var(--carbon-accent); opacity: .45; }
.bars .today .bar { opacity: 1; }
.bars .day:hover .bar { opacity: .8; }
.bars .day:hover .hit { fill: var(--orca-muted); }
.range { display: flex; justify-content: space-between; margin-top: 2px; padding-left: 66px; }
.slices ul { list-style: none; margin: 0; padding: 0; }
.slices li { margin: 4px 0; }
.slice-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
.slice-head .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.slice-head .nums { color: var(--orca-muted-foreground); white-space: nowrap; font-variant-numeric: tabular-nums; }
.track { height: 6px; background: var(--orca-muted); border-radius: 3px; overflow: hidden; margin-top: 2px; }
.fill { height: 100%; border-radius: 3px; background: var(--carbon-accent); opacity: .75; }
.fill.other { background: var(--orca-muted-foreground); opacity: .5; }
.fill.accent { opacity: 1; }
.import { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px;
  padding-top: 8px; border-top: 1px solid var(--orca-border); }
.import.running { display: block; }
.import-head { display: flex; justify-content: space-between; font-size: 12px; }
.import button { background: var(--orca-secondary); color: var(--orca-secondary-foreground);
  border: 1px solid var(--orca-border); border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.import button:hover, .periods button:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
a { color: inherit; }
footer { padding: 0 2px; }
`
