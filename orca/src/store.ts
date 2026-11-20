// The plugin's storage: the session history kept in memory and written back on change, in
// the current schema (history.ts migrate), with one write job at a time.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  BACKFILL_KEY,
  FOCUS_KEY,
  HISTORY_KEY,
  migrate,
  PICKS_KEY,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  upsert,
  type History,
  type Picks,
  type SessionRecord
} from './history.ts'
import type { Focused } from './workspaces.ts'

type Storage = Pick<OrcaWorkerApi['storage'], 'get' | 'set'>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class Store {
  private history: History = {}
  private queue: Promise<unknown> = Promise.resolve()
  private readonly storage: Storage

  constructor(storage: Storage) {
    this.storage = storage
  }

  /** Runs jobs one at a time, so two writers never overwrite each other's change. */
  serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Reads the history, migrating an older schema; true when it did. */
  async load(): Promise<boolean> {
    const [raw, version] = await Promise.all([
      this.storage.get(HISTORY_KEY),
      this.storage.get(SCHEMA_KEY)
    ])
    this.history = migrate(raw, version)
    if (version === SCHEMA_VERSION) return false
    await this.storage.set(HISTORY_KEY, this.history as never)
    await this.storage.set(SCHEMA_KEY, SCHEMA_VERSION)
    return raw !== null && raw !== undefined
  }

  get sessions(): Readonly<History> {
    return this.history
  }

  /** Stores the records (history.ts upsert); writes only when one changed. Call inside serial. */
  async put(records: SessionRecord[]): Promise<boolean> {
    let next = this.history
    let changed = false
    for (const record of records) {
      const before = next[record.sessionId]
      next = upsert(next, record)
      if (JSON.stringify(before) !== JSON.stringify(next[record.sessionId])) changed = true
    }
    if (!changed) return false
    this.history = next
    await this.storage.set(HISTORY_KEY, next as never)
    return true
  }

  async picks(): Promise<Picks> {
    const value = await this.storage.get(PICKS_KEY)
    return isObject(value) ? (value as Picks) : {}
  }

  async pick(workspaceId: string, sessionId: string): Promise<void> {
    await this.storage.set(PICKS_KEY, { ...(await this.picks()), [workspaceId]: sessionId })
  }

  async focus(): Promise<Focused | null> {
    const value = await this.storage.get(FOCUS_KEY)
    if (!isObject(value) || typeof value.name !== 'string') return null
    return {
      workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : null,
      name: value.name
    }
  }

  async setFocus(focused: Focused | null): Promise<void> {
    await this.storage.set(FOCUS_KEY, focused)
  }

  async importedAt(): Promise<number | null> {
    const value = await this.storage.get(BACKFILL_KEY)
    return isObject(value) && typeof value.finishedAt === 'number' ? value.finishedAt : null
  }

  async setImportedAt(at: number): Promise<void> {
    await this.storage.set(BACKFILL_KEY, { finishedAt: at })
  }
}
