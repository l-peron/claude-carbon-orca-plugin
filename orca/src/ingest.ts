// Turns a session's transcript files into its stored record. Node only, no Orca API.
import { PARSER_VERSION } from './carbon/transcript.ts'
import { stampOf, type TranscriptFile } from './files.ts'
import type { SessionRecord } from './history.ts'
import { readSession, TranscriptReader } from './reader.ts'

export type Meta = { title: string | null; workspaceIds: string[]; workspaceName: string | null }

/** The stamp a session's files give now: unchanged, the stored record stands. */
export function stampFor(files: TranscriptFile[]): string {
  return stampOf(files, PARSER_VERSION)
}

/** Reads one session at a time, so a session's cached files are never read twice at once. */
export class Ingest {
  private readonly reader = new TranscriptReader()
  private queue: Promise<unknown> = Promise.resolve()

  /** The session's record from its files; a file it could not read makes the stamp never match. */
  record(sessionId: string, files: TranscriptFile[], meta: Meta): Promise<SessionRecord> {
    const job = async (): Promise<SessionRecord> => {
      const usage = await readSession(this.reader, files)
      const stamp = stampFor(files)
      return {
        sessionId,
        title: meta.title,
        updatedAt: Date.now(),
        stamp: usage.failed.length > 0 ? `${stamp}|partial` : stamp,
        lastActiveAt: Math.max(0, ...files.map((f) => f.mtimeMs)),
        startedAt: usage.startedAt,
        cwd: usage.cwd,
        workspaceIds: meta.workspaceIds,
        workspaceName: meta.workspaceName,
        usage: usage.rows
      }
    }
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }
}
