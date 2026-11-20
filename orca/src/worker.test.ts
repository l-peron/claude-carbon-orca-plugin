// Runs src/worker.ts's activate(orca) over a mock host, with a Claude Code projects folder
// made in a temporary directory.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { History } from './history.ts'
import * as main from './worker.ts'

const SESSION = '0b80649f-a7c4-4d71-8bf1-755d5a1c95c4'

const assistant = (id: string, model: string, usage: object) =>
  JSON.stringify({
    type: 'assistant',
    requestId: `r-${id}`,
    timestamp: new Date().toISOString(),
    cwd: '/Users/me/repo',
    message: { id, model, usage }
  })

async function projects(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'carbon-'))
  await mkdir(join(dir, '-Users-me-repo', SESSION, 'subagents'), { recursive: true })
  await writeFile(
    join(dir, '-Users-me-repo', `${SESSION}.jsonl`),
    assistant('a', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000 }) + '\n'
  )
  await writeFile(
    join(dir, '-Users-me-repo', SESSION, 'subagents', 'agent-1.jsonl'),
    assistant('b', 'claude-haiku-4-5', { input_tokens: 1000, output_tokens: 1000 }) + '\n'
  )
  return dir
}

const done = (sessionId?: string, state: 'done' | 'working' = 'done') => ({
  workspaceId: 'w1',
  paneKey: 'p1',
  title: 'Port claude-carbon',
  state,
  receivedAt: Date.now(),
  ...(sessionId ? { sessionId } : {})
})

const EVENTS = ['agent.status.changed', 'workspace.changed']
/** An import already ran: the worker does not start one when it starts. */
const IMPORTED = { backfill: { finishedAt: 1 } }

test('stores a finished session once, with its subagents, and updates the status bar', async () => {
  const dir = await projects()
  const host = mockHost({ settings: { projectsDir: dir, dataDir: '' }, storage: IMPORTED })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.ready

  await worker.emit('agent.status.changed', done(SESSION, 'working'))
  await worker.emit('agent.status.changed', done())
  await worker.emit('agent.status.changed', done('not-a-claude-session'))
  assert.equal(host.data().storage.sessions, undefined)

  await worker.emit('agent.status.changed', done(SESSION))
  const first = (host.data().storage.sessions as unknown as History)[SESSION].updatedAt
  await worker.emit('agent.status.changed', done(SESSION))
  const history = host.data().storage.sessions as unknown as History
  assert.deepEqual(Object.keys(history), [SESSION])
  const record = history[SESSION]
  assert.equal(record.title, 'Port claude-carbon')
  assert.deepEqual(
    record.models.map((m) => m.model),
    ['claude-opus-5-5', 'claude-haiku-4-5']
  )
  // Opus 78 + 1652 g/M and haiku 10 + 207 g/M, from data/factors.json.
  assert.ok(Math.abs(record.co2Grams - (1000 * (78 + 1652) + 1000 * (10 + 207)) / 1e6) < 1e-9)
  // The same transcript twice is computed once.
  assert.equal(record.updatedAt, first)

  const summary = await worker.request('carbon.summary')
  assert.equal(summary.latest?.sessionId, SESSION)
  assert.ok(Math.abs(summary.todayTotal.co2Grams - record.co2Grams) < 1e-9)
  assert.ok(summary.dataSource?.endsWith('data'))

  const status = host.callsOf('statusBar.update').at(-1) as { text: string }
  assert.equal(status.text, '1.95\u00a0gCO₂e · today 1.95\u00a0gCO₂e')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('shows an empty status before any session', async () => {
  const host = mockHost({ settings: { projectsDir: '/nowhere', dataDir: '/nowhere' } })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.ready
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.latest, null)
  assert.equal(summary.dataSource, null)
  const status = host.callsOf('statusBar.update').at(-1) as { text: string }
  assert.equal(status.text, 'No session · today 0.00\u00a0gCO₂e')
  await worker.deactivate()
})

test('follows the focused workspace, computing its sessions on focus', async () => {
  const dir = await projects()
  const host = mockHost({
    settings: { projectsDir: dir, dataDir: '' },
    storage: IMPORTED,
    results: {
      'agents.list': {
        agents: [
          { terminalId: null, title: 'Carbon chat', agent: 'claude', state: 'waiting', stateStartedAt: 1, sessionId: SESSION },
          { terminalId: 't2', title: 'Shell', agent: null, state: 'done', stateStartedAt: 1, sessionId: null }
        ]
      }
    }
  })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.ready
  await worker.emit('workspace.changed', {
    context: { workspaceId: 'w1', branch: 'main', displayName: 'perso', terminals: [] }
  })
  // Not stored before: computed on focus, tied to the workspace.
  const history = host.data().storage.sessions as unknown as History
  assert.deepEqual(history[SESSION].workspaceIds, ['w1'])
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.focus?.name, 'perso')
  assert.equal(summary.focus?.selected, SESSION)
  assert.deepEqual(
    summary.focus?.sessions.map((s) => s.label),
    ['Carbon chat']
  )

  const picked = await worker.request('carbon.pick', { workspaceId: 'w1', sessionId: SESSION })
  assert.equal(picked.focus?.selected, SESSION)
  assert.deepEqual(host.data().storage.picks, { w1: SESSION })

  await worker.emit('workspace.changed', {
    context: { workspaceId: 'w2', branch: 'main', displayName: 'other', terminals: [] }
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('imports every transcript on its first run, then only on request and only what changed', async () => {
  const dir = await projects()
  const host = mockHost({ settings: { projectsDir: dir, dataDir: '' } })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.ready
  const history = host.data().storage.sessions as unknown as History
  assert.deepEqual(Object.keys(history), [SESSION])
  assert.equal(history[SESSION].cwd, '/Users/me/repo')
  assert.equal(typeof (host.data().storage.backfill as { finishedAt: unknown }).finishedAt, 'number')
  const progress = worker.posts.filter((p) => p.event === 'carbon.progress')
  assert.ok(progress.length >= 2)
  assert.deepEqual(
    (progress.at(-1)?.payload as { done: number; total: number; imported: number }),
    { running: true, done: 1, total: 1, imported: 1, finishedAt: null }
  )
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.backfill.running, false)
  assert.equal(summary.insights.periods['7'].sessions, 1)
  assert.deepEqual(summary.insights.periods['7'].byWorkspace.map((s) => s.name), ['repo'])
  assert.ok(summary.cars.world && summary.cars.fr)
  await worker.deactivate()

  // A restart does not import again; a request does, and skips the unchanged session.
  const again = await mountWorker(main, { host, events: EVENTS })
  await main.ready
  assert.equal(again.posts.filter((p) => p.event === 'carbon.progress').length, 0)
  assert.deepEqual(await again.request('carbon.reimport'), { started: true })
  await main.ready
  const last = again.posts.filter((p) => p.event === 'carbon.progress').at(-1)?.payload as {
    imported: number
  }
  assert.equal(last.imported, 0)
  assert.deepEqual(again.refusals, [])
  await again.deactivate()
  await rm(dir, { recursive: true, force: true })
})
