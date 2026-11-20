// The sidebar panel, an HTML panel so it can draw colours and charts: Orca builds the page
// around this module and transpiles it when it loads. It asks the worker for its state once,
// then redraws on what the worker posts. The HTML comes from src/view.ts.
import type { Period } from './insights.ts'
import type { BackfillState, CarbonState } from './protocol.ts'
import { ago } from './format.ts'
import { esc, pageHtml, STYLES, UPSTREAM } from './view.ts'

const TICK_MS = 60_000

let state: CarbonState | null = null
let period: Period = '30'
let error: string | null = null

const style = document.createElement('style')
style.textContent = STYLES
document.head.appendChild(style)
const root = document.createElement('main')
document.body.appendChild(root)

function draw(): void {
  if (error) {
    root.innerHTML = `<section><h2>Claude Carbon</h2><p>The worker did not answer: ${esc(error)}</p></section>`
    return
  }
  if (!state) {
    root.innerHTML = '<section><p class="muted">Loading…</p></section>'
    return
  }
  // Keep the focused control across a redraw, so a keyboard user does not lose their place.
  const active = (document.activeElement as HTMLElement | null)?.dataset
  const selector = active?.period
    ? `[data-period="${active.period}"]`
    : active?.action
      ? `[data-action="${active.action}"]`
      : null
  root.innerHTML = pageHtml(state, { period, now: Date.now(), locale: orca.locale })
  if (selector) root.querySelector<HTMLElement>(selector)?.focus()
}

function fail(e: unknown): void {
  error = String(e)
  draw()
}

function show(next: CarbonState): void {
  state = next
  error = null
  draw()
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'period') {
    period = (target.dataset.period as Period) ?? '30'
    draw()
  } else if (action === 'reimport') {
    void orca.plugin
      .request('carbon.reimport')
      .then(({ started }) => {
        if (started && state) show({ ...state, backfill: { ...state.backfill, running: true } })
      })
      .catch(fail)
  } else if (action === 'upstream') {
    event.preventDefault()
    void orca.shell?.openExternal(UPSTREAM).catch(() => undefined)
  }
})

root.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement
  const workspaceId = state?.focus?.workspaceId
  if (target.dataset.action !== 'pick' || !workspaceId) return
  void orca.plugin
    .request('carbon.pick', { workspaceId, sessionId: target.value })
    .then(show)
    .catch(fail)
})

orca.plugin.on('carbon.changed', show)
orca.plugin.on('carbon.progress', (backfill: BackfillState) => {
  if (state) show({ ...state, backfill })
})
// "Updated ... ago" moves: rewrite those texts only, so hovers, focus and the picker stay.
setInterval(() => {
  const now = Date.now()
  for (const el of root.querySelectorAll<HTMLElement>('[data-ago]')) {
    el.textContent = `${el.dataset.prefix ?? ''}${ago(Number(el.dataset.ago), now)}`
  }
}, TICK_MS)

draw()
orca.plugin
  .request('carbon.summary')
  .then(show)
  .catch(fail)
