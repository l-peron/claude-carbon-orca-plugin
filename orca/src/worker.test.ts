// Runs src/worker.ts's activate(orca) over a mock host, with a Claude Code projects folder
// made in a temporary directory.
import { rm } from 'node:fs/promises'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { append, assistant, dataDir, PROJECT, put, tempDir } from './fixtures.ts'
import { SCHEMA_VERSION, type History } from './history.ts'
import * as main from './worker.ts'

const SESSION = '0b80649f-a7c4-4d71-8bf1-755d5a1c95c4'
const OTHER = '6c1d2e3f-0000-4000-8000-000000000002'
const EVENTS = ['agent.status.changed', 'workspace.changed']
const DAY = 86_400_000
const out = (n: number) => ({ output_tokens: n })

/** A session with a subagent and a workflow agent, 1000 Opus output tokens each. */
async function projects(): Promise<string> {
  const dir = await tempDir()
  await put(dir, `${PROJECT}/${SESSION}.jsonl`, [assistant('a', 'claude-opus-5-5', out(1000))])
  await put(dir, `${PROJECT}/${SESSION}/subagents/agent-1.jsonl`, [assistant('b', 'claude-opus-5-5', out(1000))])
  await put(dir, `${PROJECT}/${SESSION}/subagents/workflows/wf_1/agent-2.jsonl`, [assistant('c', 'claude-opus-5-5', out(1000))])
  return dir
}

const event = (sessionId: string | undefined, state: 'done' | 'working' = 'done', workspaceId = 'w1') => ({
  workspaceId,
  paneKey: 'p1',
  title: 'Port claude-carbon',
  state,
  receivedAt: Date.now(),
  ...(sessionId ? { sessionId } : {})
})

/** A storage that already holds an import, in the current schema. */
const imported = (sessions: History = {}) => ({
  schema: SCHEMA_VERSION,
  sessions: sessions as never,
  backfill: { finishedAt: 1 }
})

const sessionsOf = (host: ReturnType<typeof mockHost>) => host.data().storage.sessions as unknown as History
const statusText = (host: ReturnType<typeof mockHost>) =>
  (host.callsOf('statusBar.update').at(-1) as { text: string }).text.replace(/ /g, ' ')

test('a stopped agent stores its session, workflow agents included, once', async () => {
  const dir = await projects()
  const factors = await dataDir({ input: 78, output: 1652 })
  const host = mockHost({ settings: { projectsDir: dir, dataDir: factors }, storage: imported() })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()

  // The start-up scan found it on disk; a working agent and an agent with no session add nothing.
  await worker.emit('agent.status.changed', event(SESSION, 'working'))
  await worker.emit('agent.status.changed', event(undefined))
  await worker.emit('agent.status.changed', event('not-a-claude-session'))
  assert.deepEqual(Object.keys(sessionsOf(host)), [SESSION])
  assert.deepEqual(sessionsOf(host)[SESSION].workspaceIds, [])

  await worker.emit('agent.status.changed', event(SESSION))
  const first = sessionsOf(host)[SESSION]
  await worker.emit('agent.status.changed', event(SESSION))
  assert.equal(sessionsOf(host)[SESSION].updatedAt, first.updatedAt, 'unchanged files are not read again')
  assert.equal(first.title, 'Port claude-carbon')
  assert.deepEqual(first.workspaceIds, ['w1'])

  // Three agents of 1000 output tokens at 1652 g/M: 4.956 g.
  assert.equal(statusText(host), '4.96 gCO₂e · today 4.96 gCO₂e')
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.dataSource, factors)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('a turn that ends adds what it wrote to the session', async () => {
  const dir = await projects()
  const host = mockHost({ settings: { projectsDir: dir, dataDir: await dataDir({ input: 0, output: 1000 }) }, storage: imported() })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  await worker.emit('agent.status.changed', event(SESSION))
  await append(`${dir}/${PROJECT}/${SESSION}.jsonl`, [assistant('d', 'claude-opus-5-5', out(2000))])
  await worker.emit('agent.status.changed', event(SESSION))
  assert.equal(statusText(host), '5.00 gCO₂e · today 5.00 gCO₂e')
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('new factors reprice the whole history without reading it again', async () => {
  const dir = await projects()
  const host = mockHost({ settings: { projectsDir: dir, dataDir: await dataDir({ input: 0, output: 1000 }) }, storage: imported() })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  await worker.emit('agent.status.changed', event(SESSION))
  assert.equal(statusText(host), '3.00 gCO₂e · today 3.00 gCO₂e')
  await worker.deactivate()

  const reads = host.data().storage.sessions
  const next = mockHost({
    settings: { projectsDir: dir, dataDir: await dataDir({ input: 0, output: 2000 }) },
    storage: host.data().storage as never
  })
  const again = await mountWorker(main, { host: next, events: EVENTS })
  await main.settled()
  assert.equal(statusText(next), '6.00 gCO₂e · today 6.00 gCO₂e')
  assert.deepEqual(next.data().storage.sessions, reads, 'nothing recomputed')
  await again.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('the first run imports every transcript; the latest is the session active last', async () => {
  const dir = await projects()
  const now = Date.now()
  // An older session, imported after the recent one in listing order.
  await put(dir, `zz-older/${OTHER}.jsonl`, [assistant('o', 'claude-opus-5-5', out(9000), { ts: new Date(now - 3 * DAY).toISOString() })], now - 3 * DAY)
  const host = mockHost({ settings: { projectsDir: dir, dataDir: await dataDir({ input: 0, output: 1000 }) } })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  assert.deepEqual(Object.keys(sessionsOf(host)).sort(), [OTHER, SESSION].sort())
  const progress = worker.posts.filter((p) => p.event === 'carbon.progress').at(-1)?.payload as { done: number; total: number }
  assert.deepEqual([progress.done, progress.total], [2, 2])
  assert.equal(statusText(host), '3.00 gCO₂e · today 3.00 gCO₂e')
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.backfill.running, false)
  assert.equal(summary.insights.periods['7'].sessions, 2)
  assert.deepEqual(summary.insights.periods['7'].byWorkspace.map((s) => s.name), ['repo'])
  await worker.deactivate()

  // A restart scans quietly and reads nothing unchanged; a request shows its progress.
  const again = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  assert.equal(again.posts.filter((p) => p.event === 'carbon.progress').length, 0)
  assert.deepEqual(await again.request('carbon.reimport'), { started: true })
  await main.settled()
  const last = again.posts.filter((p) => p.event === 'carbon.progress').at(-1)?.payload as { imported: number }
  assert.equal(last.imported, 0)
  assert.deepEqual(again.refusals, [])
  await again.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('a schema 1 history is migrated: names kept, sessions read again, lost ones kept as stored', async () => {
  const dir = await projects()
  const v1 = {
    [SESSION]: { sessionId: SESSION, title: 'Old title', updatedAt: 1, stamp: '3:1:1', workspaceIds: ['w1'], co2Grams: 999, costUsd: 9, tokens: {}, models: [], days: {} },
    gone: { sessionId: 'gone', title: 'Purged', updatedAt: 1, stamp: '1:1:1', co2Grams: 7, costUsd: 1, tokens: {}, models: [], days: { '2020-01-01': { co2Grams: 7, costUsd: 1 } } }
  }
  const host = mockHost({
    settings: { projectsDir: dir, dataDir: await dataDir({ input: 0, output: 1000 }) },
    storage: { sessions: v1, backfill: { finishedAt: 1 } }
  })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  const stored = sessionsOf(host)
  assert.equal(host.data().storage.schema, SCHEMA_VERSION)
  assert.equal(stored[SESSION].title, 'Old title')
  assert.deepEqual(stored[SESSION].workspaceIds, ['w1'])
  assert.ok(stored[SESSION].usage.length > 0, 'read again from its transcript')
  assert.equal(stored.gone.legacy?.co2Grams, 7)
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.insights.periods.all.co2Grams, 7 + 3)
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('an import never puts back a session older than the one an agent stored', async () => {
  const dir = await projects()
  const newer = Date.now() + DAY
  // What an agent's last turn stored while the import was reading older files.
  const stored = {
    [SESSION]: {
      sessionId: SESSION, title: 'Live', updatedAt: newer, stamp: 'newer', lastActiveAt: newer, startedAt: null, cwd: null,
      workspaceIds: ['w1'], workspaceName: 'perso',
      usage: [{ model: 'claude-opus-5-5', day: '2026-11-20', tokens: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 5000 } }]
    }
  }
  const host = mockHost({ settings: { projectsDir: dir, dataDir: '' }, storage: imported(stored as never) })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  assert.equal(sessionsOf(host)[SESSION].usage[0].tokens.output, 5000)
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('focus: lists the workspace’s sessions; a focus that moved mid-answer tags nothing', async () => {
  const dir = await projects()
  await put(dir, `${PROJECT}/${OTHER}.jsonl`, [assistant('o', 'claude-opus-5-5', out(10))])
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const host = mockHost({
    settings: { projectsDir: dir, dataDir: '' },
    storage: imported(),
    results: {
      'workspace.list': { workspaces: [{ id: 'wA', kind: 'worktree', name: 'alpha', path: '/nowhere/a', branch: null, hostId: 'local' }], truncated: false },
      'agents.list': async (params: { workspaceId?: string }) => {
        if (params.workspaceId === 'wA') await gate
        const sessionId = params.workspaceId === 'wA' ? SESSION : OTHER
        return { agents: [{ terminalId: 't', title: `Chat ${params.workspaceId}`, agent: 'claude', state: 'done', stateStartedAt: 1, sessionId }] }
      }
    }
  })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  const ctx = (id: string, name: string) => ({ context: { workspaceId: id, branch: 'main', displayName: name, terminals: [] } })
  const toA = worker.emit('workspace.changed', ctx('wA', 'alpha'))
  const toB = worker.emit('workspace.changed', ctx('wB', 'beta'))
  release()
  await Promise.all([toA, toB])
  await main.settled()
  const stored = sessionsOf(host)
  assert.deepEqual(stored[SESSION].workspaceIds, [], 'A answered after the focus moved to B')
  assert.deepEqual(stored[OTHER].workspaceIds, ['wB'])
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.focus?.name, 'beta')
  assert.deepEqual(summary.focus?.sessions.map((s) => s.title), ['Chat wB'])
  const picked = await worker.request('carbon.pick', { workspaceId: 'wB', sessionId: OTHER })
  assert.equal(picked.focus?.selected, OTHER)
  assert.deepEqual(host.data().storage.picks, { wB: OTHER })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  await rm(dir, { recursive: true, force: true })
})

test('shows an empty status before any session', async () => {
  const host = mockHost({ settings: { projectsDir: '/nowhere', dataDir: '/nowhere' } })
  const worker = await mountWorker(main, { host, events: EVENTS })
  await main.settled()
  const summary = await worker.request('carbon.summary')
  assert.equal(summary.dataSource, null)
  assert.equal(summary.live, true)
  assert.equal(statusText(host), 'No session · today 0.00 gCO₂e')
  await worker.deactivate()
})
