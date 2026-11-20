// Claude Code transcripts on disk for the tests: a projects folder in a temporary directory.
// Not loaded by the plugin.
import { appendFile, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionRecord } from './history.ts'

export const PROJECT = '-Users-me-repo'

/** One assistant line, as Claude Code writes it. */
export function assistant(
  id: string,
  model: string,
  usage: object,
  extra: { ts?: string; cwd?: string } = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `r-${id}`,
    timestamp: extra.ts ?? new Date().toISOString(),
    cwd: extra.cwd ?? '/Users/me/repo',
    message: { id, model, usage }
  })
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'carbon-'))
}

/** Writes `lines` at `<projects>/<rel>`, and sets its modification time when given (ms). */
export async function put(projects: string, rel: string, lines: string[], mtimeMs?: number): Promise<string> {
  const path = join(projects, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((l) => `${l}\n`).join(''))
  if (mtimeMs !== undefined) await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

export async function append(path: string, lines: string[]): Promise<void> {
  await appendFile(path, lines.map((l) => `${l}\n`).join(''))
}

/** A factors.json and prices.json with one Opus input and output factor, nothing else. */
export async function dataDir(opus: { input: number; output: number }): Promise<string> {
  const dir = await tempDir()
  await writeFile(join(dir, 'factors.json'), JSON.stringify({ models: { opus } }))
  await writeFile(join(dir, 'prices.json'), JSON.stringify({}))
  return dir
}

/** Opus tokens on 2026-11-20. */
export const opus = (input: number, output: number) => ({
  model: 'claude-opus-5-5',
  day: '2026-11-20',
  tokens: { input, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output }
})

/** A stored session with defaults. */
export function record(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    title: null,
    updatedAt: 1,
    stamp: 's',
    lastActiveAt: 1,
    startedAt: null,
    cwd: null,
    workspaceIds: [],
    workspaceName: null,
    usage: [opus(1000, 1000)],
    ...extra
  }
}
