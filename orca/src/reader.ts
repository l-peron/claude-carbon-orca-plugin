// Reads transcripts a chunk at a time and remembers where each file was left, so a session
// that grows by one turn costs the bytes of that turn, not the whole file again. Node only,
// no Orca API.
import { open } from 'node:fs/promises'
import { FileUsage, localDay, mergeRows, type UsageRow } from './carbon/transcript.ts'
import type { TranscriptFile } from './files.ts'

const CHUNK = 1 << 20
const NEWLINE = 10

/** Lets events and panel requests in between two chunks of a long read. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type Entry = { ino: number; size: number; mtimeMs: number; offset: number; usage: FileUsage }

/** Reads a session's files; what it read is reused while a file only grows. */
export class TranscriptReader {
  private cache = new Map<string, Entry>()
  private readonly maxFiles: number

  /** At most `maxFiles` files are remembered, the least recently read dropped first. */
  constructor(maxFiles = 400) {
    this.maxFiles = maxFiles
  }

  /** The file's usage, from where it was left when it only grew since; throws when unreadable. */
  async read(file: TranscriptFile): Promise<FileUsage> {
    const known = this.cache.get(file.path)
    this.cache.delete(file.path)
    if (
      known &&
      known.ino === file.ino &&
      known.size === file.size &&
      known.mtimeMs === file.mtimeMs
    ) {
      this.remember(file.path, known)
      return known.usage
    }
    // A file that grew in place goes on from the last full line; anything else starts over.
    const grew = known && known.ino === file.ino && file.size >= known.offset
    const entry: Entry = grew
      ? { ...known, size: file.size, mtimeMs: file.mtimeMs }
      : { ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, offset: 0, usage: new FileUsage() }
    entry.offset = await readLines(file.path, entry.offset, entry.usage)
    this.remember(file.path, entry)
    return entry.usage
  }

  private remember(path: string, entry: Entry): void {
    this.cache.set(path, entry)
    while (this.cache.size > this.maxFiles) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

/**
 * Feeds every full line from `offset` to the end into `usage`, and returns the offset after
 * the last line it took. A last line with no newline is taken when it parses as JSON (Claude
 * Code ends each line with one; a half-written line does not parse, and is read again later).
 */
async function readLines(path: string, offset: number, usage: FileUsage): Promise<number> {
  const handle = await open(path, 'r')
  const decoder = new TextDecoder()
  let position = offset
  let carry = new Uint8Array(0)
  try {
    const chunk = new Uint8Array(CHUNK)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position)
      if (bytesRead === 0) break
      position += bytesRead
      const buf = new Uint8Array(carry.length + bytesRead)
      buf.set(carry)
      buf.set(chunk.subarray(0, bytesRead), carry.length)
      const end = buf.lastIndexOf(NEWLINE)
      if (end < 0) {
        carry = buf
        continue
      }
      for (const line of decoder.decode(buf.subarray(0, end)).split('\n')) usage.addLine(line)
      carry = buf.slice(end + 1)
      await breathe()
    }
  } finally {
    await handle.close()
  }
  if (carry.length > 0) {
    const last = decoder.decode(carry)
    try {
      JSON.parse(last)
    } catch {
      return position - carry.length
    }
    usage.addLine(last)
  }
  return position
}

export type SessionUsage = {
  rows: UsageRow[]
  startedAt: number | null
  cwd: string | null
  /** Files that could not be read and were left out. */
  failed: string[]
}

/**
 * A session's usage over its files, each reduced on its own as claude-carbon does. A file
 * that cannot be read is left out, as claude-carbon leaves out an unreadable agent.
 */
export async function readSession(
  reader: TranscriptReader,
  files: TranscriptFile[]
): Promise<SessionUsage> {
  const rows: UsageRow[] = []
  const failed: string[] = []
  let startedAt: number | null = null
  let cwd: string | null = null
  for (const file of files) {
    let usage: FileUsage
    try {
      usage = await reader.read(file)
    } catch {
      failed.push(file.path)
      continue
    }
    // A message with no timestamp falls on the day its file last changed.
    rows.push(...usage.rows(localDay(file.mtimeMs)))
    startedAt ??= usage.firstTimestamp
    cwd ??= usage.cwd
  }
  return { rows: mergeRows(rows), startedAt, cwd, failed }
}
