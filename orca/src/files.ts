// What the worker reads from disk: a Claude Code session's transcripts and claude-carbon's
// factors and prices. Node only, no Orca API, so it moves with the carbon code.
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFactors, type Factors } from './carbon/co2.ts'
import { parsePrices, type Prices } from './carbon/cost.ts'

/** A path a person typed in Settings, with a leading ~ for their home folder. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Claude Code's transcript folder: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function defaultProjectsDir(): string {
  const config = process.env.CLAUDE_CONFIG_DIR
  return join(config ? config : join(homedir(), '.claude'), 'projects')
}

/**
 * Folders that may hold factors.json and prices.json, first match wins: claude-carbon's own
 * data/ at the repository root (this plugin lives in its orca/ folder), then a data/ copy
 * beside the plugin, for a copy of orca/ alone.
 */
export function defaultDataDirs(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  return [join(root, '..', 'data'), join(root, 'data')]
}

// Session ids are UUIDs; anything with a path separator or a dot could leave the folder.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export type TranscriptFile = { path: string; size: number; mtimeMs: number; ino: number }

async function fileInfo(path: string): Promise<TranscriptFile | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino } : null
  } catch {
    return null
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return [] // missing or unreadable: nothing there
  }
}

async function folders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * A session's subagent transcripts, as claude-carbon's cc_collect_subagents finds them:
 * `<session>/subagents/*.jsonl`, and the agents a workflow started,
 * `<session>/subagents/workflows/<wf>/agent-*.jsonl` (the workflow's journal.jsonl beside
 * them carries no usage).
 */
async function subagentFiles(sessionDir: string): Promise<TranscriptFile[]> {
  const dir = join(sessionDir, 'subagents')
  const paths = (await names(dir)).filter((n) => n.endsWith('.jsonl')).sort().map((n) => join(dir, n))
  const workflows = join(dir, 'workflows')
  for (const wf of (await folders(workflows)).sort()) {
    for (const n of (await names(join(workflows, wf))).sort()) {
      if (n.startsWith('agent-') && n.endsWith('.jsonl')) paths.push(join(workflows, wf, n))
    }
  }
  const found: TranscriptFile[] = []
  for (const path of paths) {
    const info = await fileInfo(path)
    if (info) found.push(info)
  }
  return found
}

/** The main transcript of a session in one project folder, then its subagents'; empty when none. */
async function sessionFiles(projectDir: string, sessionId: string): Promise<TranscriptFile[]> {
  const main = await fileInfo(join(projectDir, `${sessionId}.jsonl`))
  return main ? [main, ...(await subagentFiles(join(projectDir, sessionId)))] : []
}

/**
 * The transcripts of a session, `<project>/<sessionId>.jsonl` and its subagents', in every
 * project folder. Empty when there is none, such as for an agent other than Claude Code.
 */
export async function findTranscripts(
  projectsDir: string,
  sessionId: string
): Promise<TranscriptFile[]> {
  if (!SESSION_ID.test(sessionId)) return []
  const found: TranscriptFile[] = []
  for (const project of await folders(projectsDir)) {
    found.push(...(await sessionFiles(join(projectsDir, project), sessionId)))
  }
  return found
}

/** Changes whenever a file grows, is rewritten or is added, or the parser changes; stored. */
export function stampOf(files: TranscriptFile[], parser: number): string {
  const size = files.reduce((sum, f) => sum + f.size, 0)
  const mtime = Math.max(0, ...files.map((f) => f.mtimeMs))
  return `${parser}|${files.length}:${size}:${Math.round(mtime)}`
}

/**
 * Every session under the projects folder: each `<project>/<id>.jsonl` with its subagents'
 * transcripts, one listing per folder. A session id in two folders gets both folders' files.
 */
export async function listAllSessions(
  projectsDir: string
): Promise<{ sessionId: string; files: TranscriptFile[] }[]> {
  const sessions = new Map<string, TranscriptFile[]>()
  for (const project of await folders(projectsDir)) {
    const dir = join(projectsDir, project)
    for (const name of await names(dir)) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : ''
      if (!SESSION_ID.test(id)) continue
      const files = await sessionFiles(dir, id)
      if (files.length > 0) sessions.set(id, [...(sessions.get(id) ?? []), ...files])
    }
  }
  return [...sessions].map(([sessionId, files]) => ({ sessionId, files }))
}

export type CarbonData = {
  factors: Factors
  prices: Prices
  /** factors.json as read, for its equivalences; undefined with the built-in defaults. */
  factorsJson?: unknown
  source: string | null
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Factors and prices from the first folder with a factors.json. Missing or unreadable, they
 * fall back to claude-carbon's built-in defaults, as its jq does; `source` is then null.
 */
export async function loadCarbonData(dirs: string[]): Promise<CarbonData> {
  for (const dir of dirs) {
    const factors = await readJson(join(dir, 'factors.json'))
    if (factors === undefined) continue
    const prices = await readJson(join(dir, 'prices.json'))
    return {
      factors: parseFactors(factors),
      prices: parsePrices(prices) ?? parsePrices({})!,
      factorsJson: factors,
      source: dir
    }
  }
  return { factors: parseFactors({}), prices: parsePrices({})!, source: null }
}
