// The plugin's worker: it reads Claude Code transcripts, prices them with claude-carbon's
// factors (src/carbon/) and stores one record per session. It records a session when its agent
// finishes a turn in Orca or its workspace comes into focus, and imports every transcript
// already on disk once, in the background. Orca keeps it running while the plugin is enabled,
// because of the status bar item. A save restarts it and drops its in-memory state, so
// everything that must last lives in orca.storage.
import type { OrcaWorkerApi } from 'orca/worker'
import { readFile } from 'node:fs/promises'
import { carEquivalence, equivalenceSet } from './carbon/equiv.ts'
import { sessionTotals } from './carbon/session.ts'
import {
  firstCwd,
  firstTimestamp,
  localDay,
  mergeRows,
  parseTranscript
} from './carbon/transcript.ts'
import {
  defaultDataDirs,
  defaultProjectsDir,
  expandHome,
  findTranscripts,
  listAllSessions,
  loadCarbonData,
  stampOf,
  type CarbonData,
  type TranscriptFile
} from './files.ts'
import { formatCo2, formatUsd, statusText } from './format.ts'
import {
  focusOf,
  HISTORY_KEY,
  mergeIds,
  PICKS_KEY,
  summarize,
  toRecord,
  upsert,
  type History,
  type Picks,
  type SessionRecord
} from './history.ts'
import { insights } from './insights.ts'
import type { BackfillState, CarbonState, EquivalenceSet } from './protocol.ts'

const STATUS_ITEM = 'carbon'
/** The last focused workspace, so a restarted worker shows it before Orca's next event. */
const FOCUS_KEY = 'focus'
/** When the last full import ended. */
const BACKFILL_KEY = 'backfill'
/** Sessions the import computes before it stores them and tells the panel. */
const BATCH = 8

type Meta = { title: string | null; workspaceIds: string[]; workspaceName: string | null }

async function stringSetting(orca: OrcaWorkerApi, key: string): Promise<string> {
  try {
    const value = await orca.settings.get(key)
    return typeof value === 'string' ? expandHome(value.trim()) : ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readHistory(orca: OrcaWorkerApi): Promise<History> {
  const value = await orca.storage.get(HISTORY_KEY)
  return isRecord(value) ? (value as unknown as History) : {}
}

/** Lets events and panel requests in between two files of a long import. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The locale's set; null when no locale variable names one (the panel then uses Orca's). */
function envSet(): EquivalenceSet | null {
  const values = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
  const asEnglish = equivalenceSet(values, 'en')
  return asEnglish === equivalenceSet(values, 'fr') ? asEnglish : null
}

/** A session's record from its whole transcript and its subagents'. */
async function computeRecord(
  sessionId: string,
  files: TranscriptFile[],
  meta: Meta,
  data: CarbonData
): Promise<SessionRecord> {
  const now = Date.now()
  const today = localDay(now)
  const rows = []
  let startedAt: number | null = null
  let cwd: string | null = null
  for (const file of files) {
    const text = await readFile(file.path, 'utf8')
    rows.push(...parseTranscript(text, today))
    startedAt ??= firstTimestamp(text)
    cwd ??= firstCwd(text)
    await breathe()
  }
  const totals = sessionTotals(mergeRows(rows), data.factors, data.prices)
  return toRecord(sessionId, meta.title, totals, now, stampOf(files), {
    workspaceIds: meta.workspaceIds,
    workspaceName: meta.workspaceName,
    startedAt,
    cwd,
    lastActiveAt: Math.max(...files.map((f) => f.mtimeMs))
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  let dataSource: string | null = null
  let factorsJson: unknown
  /** The workspace Orca has in focus, from workspace.changed; null when none is. */
  let focused: { workspaceId: string | null; name: string } | null = null
  /** Sessions Orca lists in the focused workspace, session id to agent title. */
  let live: Record<string, string | null> = {}
  let backfill: BackfillState = { running: false, done: 0, total: 0, imported: 0, finishedAt: null }
  // Storage is read, changed and written back; one job at a time keeps two sessions that
  // finish together from overwriting each other.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job)
    queue = next.catch(() => undefined)
    return next
  }

  async function loadData(): Promise<CarbonData> {
    const dir = await stringSetting(orca, 'dataDir')
    const data = await loadCarbonData(dir ? [dir] : defaultDataDirs())
    dataSource = data.source
    factorsJson = data.factorsJson
    return data
  }

  async function projectsDir(): Promise<string> {
    return (await stringSetting(orca, 'projectsDir')) || defaultProjectsDir()
  }

  async function readPicks(): Promise<Picks> {
    const value = await orca.storage.get(PICKS_KEY)
    return isRecord(value) ? (value as unknown as Picks) : {}
  }

  async function state(history?: History): Promise<CarbonState> {
    const stored = history ?? (await readHistory(orca))
    const today = localDay(Date.now())
    const focus = focused
      ? focusOf(
          stored,
          {
            ids: focused.workspaceId ? [focused.workspaceId] : [],
            name: focused.name,
            workspaceId: focused.workspaceId
          },
          live,
          await readPicks()
        )
      : null
    const cars: CarbonState['cars'] = {}
    for (const set of ['fr', 'us', 'world'] as const) {
      const car = carEquivalence(factorsJson, set)
      if (car) cars[set] = car
    }
    return {
      ...summarize(stored, today),
      dataSource,
      focus,
      insights: insights(stored, today),
      cars,
      envSet: envSet(),
      backfill
    }
  }

  async function showStatus(current: CarbonState): Promise<void> {
    const latest = current.latest
    const tooltip = [
      latest
        ? `Latest session: ${formatCo2(latest.co2Grams)}, ${formatUsd(latest.costUsd)} API-equivalent`
        : 'No Claude Code session recorded yet',
      `Today: ${formatCo2(current.todayTotal.co2Grams)}, ${formatUsd(current.todayTotal.costUsd)}`,
      `Last 30 days: ${formatCo2(current.last30.co2Grams)}, ${formatUsd(current.last30.costUsd)}`,
      'Estimate from claude-carbon (github.com/gwittebolle/claude-carbon)'
    ].join('\n')
    try {
      await orca.host.call('statusBar.update', {
        id: STATUS_ITEM,
        text: statusText(latest ? latest.co2Grams : null, current.todayTotal.co2Grams),
        tooltip
      })
    } catch (error) {
      // Desktop app only: a headless Orca has no status bar.
      orca.log(`status bar: ${String(error)}`)
    }
  }

  async function publish(): Promise<void> {
    const current = await state()
    orca.panels.post('carbon.changed', current)
    await showStatus(current)
  }

  /**
   * Recomputes a session from its whole transcript, so doing it twice stores it once; an
   * unchanged transcript only gains the workspace ids, title and name. Runs inside serial.
   */
  async function recordSession(sessionId: string, meta: Meta): Promise<void> {
    const files = await findTranscripts(await projectsDir(), sessionId)
    if (files.length === 0) return // not a Claude Code session, or not written yet
    const history = await readHistory(orca)
    const previous: SessionRecord | undefined = history[sessionId]
    if (previous && previous.stamp === stampOf(files)) {
      const ids = mergeIds(previous.workspaceIds, meta.workspaceIds)
      const same =
        ids.length === (previous.workspaceIds ?? []).length &&
        (previous.title || !meta.title) &&
        (previous.workspaceName || !meta.workspaceName)
      if (same) return
      const next = upsert(history, {
        ...previous,
        title: previous.title ?? meta.title,
        workspaceName: previous.workspaceName ?? meta.workspaceName,
        workspaceIds: ids
      })
      await orca.storage.set(HISTORY_KEY, next as never)
      return
    }
    const record = await computeRecord(sessionId, files, meta, await loadData())
    await orca.storage.set(HISTORY_KEY, upsert(await readHistory(orca), record) as never)
  }

  /** Lists the focused workspace's agents and stores any Claude Code session not stored yet. */
  async function refreshFocus(): Promise<void> {
    live = {}
    if (!focused) return
    let agents: { sessionId?: string | null; title: string | null }[] = []
    try {
      agents = (await orca.host.call('agents.list', {})).agents
    } catch (error) {
      orca.log(`agents.list: ${String(error)}`)
    }
    const workspaceIds = focused.workspaceId ? [focused.workspaceId] : []
    for (const agent of agents) {
      if (!agent.sessionId) continue
      live[agent.sessionId] = agent.title
      await recordSession(agent.sessionId, {
        title: agent.title,
        workspaceIds,
        workspaceName: focused.name
      })
    }
  }

  /**
   * Imports every transcript on disk, skipping sessions whose files have not changed. It
   * reads files outside the storage queue and stores a batch at a time, so events and panel
   * requests are served meanwhile.
   */
  async function runBackfill(): Promise<void> {
    if (backfill.running) return
    backfill = { ...backfill, running: true, done: 0, total: 0, imported: 0 }
    try {
      const sessions = await listAllSessions(await projectsDir())
      backfill = { ...backfill, total: sessions.length }
      orca.panels.post('carbon.progress', backfill)
      const data = await loadData()
      let known = await readHistory(orca)
      let batch: SessionRecord[] = []
      const flush = async () => {
        const records = batch
        batch = []
        if (records.length > 0) {
          known = await serial(async () => {
            let history = await readHistory(orca)
            for (const record of records) history = upsert(history, record)
            await orca.storage.set(HISTORY_KEY, history as never)
            return history
          })
        }
        orca.panels.post('carbon.progress', backfill)
      }
      for (const { sessionId, files } of sessions) {
        const previous = known[sessionId]
        if (!previous || previous.stamp !== stampOf(files)) {
          const meta = { title: previous?.title ?? null, workspaceIds: [], workspaceName: null }
          try {
            batch.push(await computeRecord(sessionId, files, meta, data))
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
      await orca.storage.set(BACKFILL_KEY, { finishedAt: backfill.finishedAt })
    } catch (error) {
      orca.log(`import: ${String(error)}`)
    } finally {
      backfill = { ...backfill, running: false }
      await serial(publish)
    }
  }

  orca.events.on('agent.status.changed', (event) => {
    if (event.state !== 'done' || !event.sessionId) return
    const sessionId = event.sessionId
    const workspaceIds = [event.workspaceId, event.workspaceListId].filter(
      (id): id is string => typeof id === 'string' && id !== ''
    )
    const inFocus = !!focused?.workspaceId && workspaceIds.includes(focused.workspaceId)
    return serial(async () => {
      await recordSession(sessionId, {
        title: event.title ?? null,
        workspaceIds,
        workspaceName: inFocus && focused ? focused.name : null
      })
      if (inFocus) live[sessionId] = event.title ?? live[sessionId] ?? null
      await publish()
    }).catch((error) => orca.log(`session ${sessionId}: ${String(error)}`))
  })

  orca.events.on('workspace.changed', ({ context }) => {
    focused = context
      ? { workspaceId: context.workspaceId ?? null, name: context.displayName }
      : null
    return serial(async () => {
      await orca.storage.set(FOCUS_KEY, focused)
      await refreshFocus()
      await publish()
    }).catch((error) => orca.log(`focus: ${String(error)}`))
  })

  orca.panels.handle('carbon.summary', () => serial(() => state()))

  orca.panels.handle('carbon.pick', ({ workspaceId, sessionId }) =>
    serial(async () => {
      await orca.storage.set(PICKS_KEY, { ...(await readPicks()), [workspaceId]: sessionId })
      const current = await state()
      orca.panels.post('carbon.changed', current)
      return current
    })
  )

  orca.panels.handle('carbon.reimport', () => {
    if (backfill.running) return { started: false }
    ready = runBackfill()
    return { started: true }
  })

  // "Today" moves at midnight even when no agent finishes; redraw the status bar then.
  const atMidnight = () => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    midnight = setTimeout(() => {
      void serial(async () => showStatus(await state())).finally(atMidnight)
    }, next.getTime() - now.getTime())
    // Node: the timer alone must not keep the worker process (or a test run) alive.
    ;(midnight as unknown as { unref?: () => void }).unref?.()
  }
  atMidnight()

  ready = serial(async () => {
    await loadData()
    // Orca sends workspace.changed to a new subscriber; until then, the last focus known.
    if (!focused) {
      const stored = await orca.storage.get(FOCUS_KEY)
      if (isRecord(stored) && typeof stored.name === 'string') {
        focused = stored as unknown as { workspaceId: string | null; name: string }
      }
    }
    const done = await orca.storage.get(BACKFILL_KEY)
    if (isRecord(done) && typeof done.finishedAt === 'number') {
      backfill = { ...backfill, finishedAt: done.finishedAt }
    }
    await showStatus(await state())
  }).then(() => {
    // The first run imports what is already on disk; later runs only on request.
    if (backfill.finishedAt === null) return runBackfill()
  })
}

let midnight: ReturnType<typeof setTimeout> | undefined
/** Startup, and the first import when it starts one; tests wait on it. */
export let ready: Promise<void> = Promise.resolve()

export function deactivate(): void {
  clearTimeout(midnight)
}
