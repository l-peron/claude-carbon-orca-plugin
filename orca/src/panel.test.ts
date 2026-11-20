// The panel's states end to end: the worker on a stand-in host answers carbon.summary, and
// the page drawn from it reads as expected. `orca plugin check` renders components panels
// only, so these stand in for check scenarios of this HTML panel.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { SCHEMA_VERSION } from './history.ts'
import { pageHtml } from './view.ts'
import * as main from './worker.ts'

const day = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const today = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`

/** A stored session of `output` Opus output tokens today, in workspace w1. */
const session = (id: string, title: string, output: number) => ({
  sessionId: id,
  title,
  updatedAt: Date.now(),
  stamp: 'stored',
  lastActiveAt: Date.now(),
  startedAt: null,
  cwd: '/w/my-app',
  workspaceIds: ['w1'],
  workspaceName: 'my-app',
  usage: [{ model: 'claude-opus-5-5', day: today, tokens: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output } }]
})

// No transcripts on disk: only stored sessions show.
const settings = { projectsDir: '/nonexistent/projects', dataDir: '' }
const stored = {
  schema: SCHEMA_VERSION,
  backfill: { finishedAt: Date.now() - 3_600_000 },
  sessions: { a: session('a', 'Add dark mode', 120_000), b: session('b', 'Fix login redirect', 40_000) }
}
const focus = { context: { workspaceId: 'w1', branch: 'main', displayName: 'my-app', terminals: [] } }

async function page(options: Parameters<typeof mockHost>[0], focused: boolean): Promise<string> {
  const worker = await mountWorker(main, { host: mockHost(options), events: ['agent.status.changed', 'workspace.changed'] })
  await main.settled()
  if (focused) await worker.emit('workspace.changed', focus)
  await main.settled()
  const html = pageHtml(await worker.request('carbon.summary'), { period: '30', now: Date.now(), locale: 'en' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  return html.replace(/<[^>]*>/g, ' ').replace(/[\s ]+/g, ' ')
}

test('empty: no workspace, no history', async () => {
  const text = await page({ settings }, false)
  assert.ok(text.includes('Open a workspace in Orca'))
  assert.ok(text.includes('0.00 gCO₂e emissions'))
})

test('history only: totals and breakdowns, no current session', async () => {
  const text = await page({ settings, storage: stored }, false)
  assert.ok(text.includes('264 gCO₂e emissions'))
  assert.ok(text.includes('2 sessions'))
  assert.ok(text.includes('By workspace my-app'))
  // The start-up scan just looked at the (empty) projects folder.
  assert.ok(text.includes('Imported less than a minute ago'))
})

test('focused: the workspace’s latest session, with the picker', async () => {
  const text = await page({ settings, storage: stored }, true)
  assert.ok(text.includes('Current session my-app'))
  assert.ok(text.includes('198 gCO₂e'))
  assert.ok(text.includes('Add dark mode'))
})

test('Orca refuses agents.list: stored sessions still show', async () => {
  const text = await page(
    { settings, storage: stored, results: { 'agents.list': () => { throw hostError('unavailable') } } },
    true
  )
  assert.ok(text.includes('Current session my-app'))
  assert.ok(text.includes('198 gCO₂e'))
})
