// The plugin's worker: it reads Claude Code transcripts and stores each session's tokens
// (src/ingest.ts, src/store.ts), and prices them with claude-carbon's factors when it shows
// them. It records a session when its agent stops in Orca or its workspace comes into
// focus, and scans every transcript on disk when it starts, at midnight and every
// RESCAN_MS, skipping unchanged ones. Orca keeps it running while the plugin is enabled,
// because of the status bar item. A save restarts it and drops its in-memory state, so
// everything that must last lives in orca.storage.
import type { OrcaWorkerApi } from 'orca/worker'
import { carEquivalence, equivalenceSet } from './carbon/equiv.ts'
import { localDay } from './carbon/transcript.ts'
import {
  defaultDataDirs,
  defaultProjectsDir,
  expandHome,
  findTranscripts,
  listAllSessions,
  loadCarbonData,
  type CarbonData,
  type TranscriptFile
} from './files.ts'
import { formatCo2, formatUsd, statusText } from './format.ts'
import { latestOf, price, type Priced, type SessionRecord } from './history.ts'
import { Ingest, stampFor, type Meta } from './ingest.ts'
import { insights } from './insights.ts'
import type { BackfillState, CarbonState, EquivalenceSet } from './protocol.ts'
import { Store } from './store.ts'
import { focusOf, type Focused, type Workspace } from './workspaces.ts'

const STATUS_ITEM = 'carbon'
/** Sessions the import computes before it stores them and tells the panel. */
const BATCH = 8
/** How often the worker looks for sessions run outside Orca. */
const RESCAN_MS = 15 * 60_000
/** Agent states after which a turn's transcript is worth reading. */
const STOPPED = new Set(['done', 'waiting', 'blocked'])

/** The locale's set; null when no locale variable names one (the panel then uses Orca's). */
function envSet(): EquivalenceSet | null {
  // equivalenceSet falls back on its second argument only when no variable names a set.
  const values = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
  const asEnglish = equivalenceSet(values, 'en')
  return asEnglish === equivalenceSet(values, 'fr') ? asEnglish : null
}

/** The running worker's queues, so tests can wait until it is idle. */
let current: { idle: () => Promise<void> } | null = null

/** Resolves once the running worker has nothing left to do: start-up, scans, writes. */
export function settled(): Promise<void> {
  return current ? current.idle() : Promise.resolve()
}

export default function activate(orca: OrcaWorkerApi): void {
  const store = new Store(orca.storage)
  const ingest = new Ingest()
  /** Host API 1.8 gives agents' session ids; before it only the scans record sessions. */
  const liveApi = orca.api.major > 1 || orca.api.minor >= 8
  let data: CarbonData | null = null
  /** The workspace Orca has in focus, from workspace.changed; null when none is. */
  let focused: Focused | null = null
  /** Sessions Orca lists in the focused workspace, session id to agent title. */
  let live: Record<string, string | null> = {}
  let workspaces: Workspace[] = []
  let backfill: BackfillState = { running: false, done: 0, total: 0, imported: 0, finishedAt: null }
  /** The scan in progress; `visible` when the panel shows its progress. */
  let scan: { visible: boolean; done: Promise<void> } | null = null
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let pending: Promise<unknown> = Promise.resolve()
  /** Keeps a background job for settled(), and logs its failure. */
  const track = (job: Promise<unknown>, what: string): void => {
    const logged = job.catch((error) => orca.log(`${what}: ${String(error)}`))
    pending = Promise.all([pending, logged])
  }

  async function setting(key: string): Promise<string> {
    try {
      const value = await orca.settings.get(key)
      return typeof value === 'string' ? expandHome(value.trim()) : ''
    } catch {
      return ''
    }
  }

  async function loadData(): Promise<CarbonData> {
    const dir = await setting('dataDir')
    data = await loadCarbonData(dir ? [dir] : defaultDataDirs())
    return data
  }

  async function projectsDir(): Promise<string> {
    return (await setting('projectsDir')) || defaultProjectsDir()
  }

  async function refreshWorkspaces(): Promise<void> {
    try {
      const { workspaces: rows } = await orca.host.call('workspace.list', {})
      workspaces = rows.map((w) => ({ id: w.id, name: w.name, path: w.path }))
    } catch (error) {
      orca.log(`workspace.list: ${String(error)}`)
    }
  }

  function priced(d: CarbonData): Priced[] {
    return Object.values(store.sessions).map((r) => price(r, d.factors, d.prices))
  }

  async function state(): Promise<CarbonState> {
    const d = data ?? (await loadData())
    const sessions = priced(d)
    const today = localDay(Date.now())
    const cars: CarbonState['cars'] = {}
    for (const set of ['fr', 'us', 'world'] as const) {
      const car = carEquivalence(d.factorsJson, set)
      if (car) cars[set] = car
    }
    return {
      today,
      dataSource: d.source,
      focus: focused ? focusOf(sessions, focused, workspaces, live, await store.picks()) : null,
      insights: insights(sessions, today, workspaces),
      cars,
      envSet: envSet(),
      backfill,
      live: liveApi
    }
  }

  async function showStatus(): Promise<void> {
    const d = data ?? (await loadData())
    const sessions = priced(d)
    const latest = latestOf(sessions)
    const view = insights(sessions, localDay(Date.now()), workspaces)
    const last30 = view.periods['30']
    const tooltip = [
      latest
        ? `Latest session: ${formatCo2(latest.co2Grams)}, ${formatUsd(latest.costUsd)} API-equivalent`
        : 'No Claude Code session recorded yet',
      `Today: ${formatCo2(view.today.co2Grams)}, ${formatUsd(view.today.costUsd)}`,
      `Last 30 days: ${formatCo2(last30.co2Grams)}, ${formatUsd(last30.costUsd)}`,
      'Estimate from claude-carbon (github.com/gwittebolle/claude-carbon)'
    ].join('\n')
    try {
      await orca.host.call('statusBar.update', {
        id: STATUS_ITEM,
        text: statusText(latest ? latest.co2Grams : null, view.today.co2Grams),
        tooltip
      })
    } catch (error) {
      // Desktop app only: a headless Orca has no status bar.
      orca.log(`status bar: ${String(error)}`)
    }
  }

  async function publish(): Promise<void> {
    if (disposed) return
    orca.panels.post('carbon.changed', await state())
    await showStatus()
  }

  /**
   * Stores a session from its files: read again only when they changed since it was stored,
   * else only its names and workspaces are added. Reading happens outside the storage queue.
   */
  async function sync(sessionId: string, meta: Meta, known?: TranscriptFile[]): Promise<void> {
    const files = known ?? (await findTranscripts(await projectsDir(), sessionId))
    if (files.length === 0) return // not a Claude Code session, or not written yet
    const previous = store.sessions[sessionId]
    const record =
      previous && previous.stamp === stampFor(files)
        ? { ...previous, ...meta, title: meta.title ?? previous.title }
        : await ingest.record(sessionId, files, meta)
    await store.serial(() => store.put([record]))
  }

  /** Lists the target workspace's agents and stores their Claude Code sessions. */
  async function refreshFocus(target: Focused): Promise<void> {
    let agents: { sessionId?: string | null; title: string | null }[] = []
    try {
      const params = target.workspaceId ? { workspaceId: target.workspaceId } : {}
      agents = (await orca.host.call('agents.list', params)).agents
    } catch (error) {
      orca.log(`agents.list: ${String(error)}`)
    }
    // The focus moved while Orca answered: these agents are not the new workspace's.
    if (focused !== target) return
    live = {}
    for (const agent of agents) if (agent.sessionId) live[agent.sessionId] = agent.title
    for (const [sessionId, title] of Object.entries(live)) {
      await sync(sessionId, {
        title,
        workspaceIds: target.workspaceId ? [target.workspaceId] : [],
        workspaceName: target.name
      })
    }
  }

  /** Looks at every transcript on disk and stores the sessions that changed. */
  async function runScan(): Promise<void> {
    const sessions = await listAllSessions(await projectsDir())
    backfill = { ...backfill, done: 0, total: sessions.length, imported: 0 }
    const progress = () => {
      if (scan?.visible) orca.panels.post('carbon.progress', backfill)
    }
    progress()
    let batch: SessionRecord[] = []
    const flush = async () => {
      const records = batch
      batch = []
      if (records.length > 0) await store.serial(() => store.put(records))
      progress()
    }
    for (const { sessionId, files } of sessions) {
      if (disposed) return
      const previous = store.sessions[sessionId]
      if (!previous || previous.stamp !== stampFor(files)) {
        const meta = { title: null, workspaceIds: [], workspaceName: null }
        try {
          batch.push(await ingest.record(sessionId, files, meta))
          backfill = { ...backfill, imported: backfill.imported + 1 }
        } catch (error) {
          orca.log(`import ${sessionId}: ${String(error)}`)
        }
      }
      backfill = { ...backfill, done: backfill.done + 1 }
      if (batch.length >= BATCH || backfill.done % 25 === 0) await flush()
    }
    await flush()
    backfill = { ...backfill, finishedAt: Date.now() }
    await store.setImportedAt(backfill.finishedAt as number)
  }

  /** Starts a scan, or shows the one running when `visible`; false when one already showed. */
  function startScan(visible: boolean): boolean {
    if (scan) {
      if (!visible || scan.visible) return false
      scan.visible = true
      backfill = { ...backfill, running: true }
      orca.panels.post('carbon.progress', backfill)
      return true
    }
    const run = { visible, done: Promise.resolve() }
    scan = run
    if (visible) backfill = { ...backfill, running: true }
    run.done = (async () => {
      try {
        await loadData()
        await runScan()
      } finally {
        scan = null
        backfill = { ...backfill, running: false }
        await publish()
      }
    })()
    track(run.done, 'import')
    return true
  }

  function every(ms: () => number, job: () => void): void {
    const arm = () => {
      if (disposed) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        job()
        arm()
      }, ms())
      // Node: the timer alone must not keep the worker process (or a test run) alive.
      ;(timer as unknown as { unref?: () => void }).unref?.()
      timers.add(timer)
    }
    arm()
  }

  orca.events.on('agent.status.changed', (event) => {
    if (!STOPPED.has(event.state) || !event.sessionId) return
    const sessionId = event.sessionId
    const workspaceIds = [event.workspaceId, event.workspaceListId].filter(
      (id): id is string => typeof id === 'string' && id !== ''
    )
    const target = focused
    const inFocus = !!target?.workspaceId && workspaceIds.includes(target.workspaceId)
    const job = (async () => {
      await sync(sessionId, {
        title: event.title ?? null,
        workspaceIds,
        workspaceName: inFocus && target ? target.name : null
      })
      if (inFocus && focused === target) live[sessionId] = event.title ?? live[sessionId] ?? null
      await publish()
    })()
    track(job, `session ${sessionId}`)
    return job.catch(() => undefined)
  })

  orca.events.on('workspace.changed', ({ context }) => {
    const target: Focused | null = context
      ? { workspaceId: context.workspaceId ?? null, name: context.displayName }
      : null
    focused = target
    live = {}
    const job = (async () => {
      await store.setFocus(target)
      await refreshWorkspaces()
      if (target) await refreshFocus(target)
      await publish()
    })()
    track(job, 'focus')
    return job.catch(() => undefined)
  })

  orca.settings.onDidChange(({ key }) => {
    if (key === 'dataDir') {
      track(loadData().then(publish), 'factors')
    }
    if (key === 'projectsDir') startScan(true)
  })

  orca.panels.handle('carbon.summary', () => state())

  orca.panels.handle('carbon.pick', async ({ workspaceId, sessionId }) => {
    await store.serial(() => store.pick(workspaceId, sessionId))
    const next = await state()
    orca.panels.post('carbon.changed', next)
    return next
  })

  orca.panels.handle('carbon.reimport', () => ({ started: startScan(true) }))

  // "Today" moves at midnight even when no agent stops: redraw, and pick up the day's sessions.
  every(
    () => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime() - now.getTime()
    },
    () => startScan(false)
  )
  every(() => RESCAN_MS, () => startScan(false))

  const startup = (async () => {
    const migrated = await store.load()
    await loadData()
    // Orca sends workspace.changed to a new subscriber; until then, the last focus known.
    if (!focused) focused = await store.focus()
    await refreshWorkspaces()
    backfill = { ...backfill, finishedAt: migrated ? null : await store.importedAt() }
    await showStatus()
    // The first run, and a migrated history, show their import; later starts scan quietly.
    startScan(backfill.finishedAt === null)
  })()
  track(startup, 'start')

  const instance = {
    idle: async () => {
      // Jobs can start more jobs: wait until a pass adds none.
      for (;;) {
        const seen = pending
        await seen
        await scan?.done
        if (seen === pending && !scan) return
      }
    },
    dispose: () => {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }
  current = instance
  disposers.push(instance.dispose)
}

const disposers: (() => void)[] = []

export function deactivate(): void {
  for (const dispose of disposers.splice(0)) dispose()
}
