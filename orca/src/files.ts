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

export type TranscriptFile = { path: string; size: number; mtimeMs: number }

async function fileInfo(path: string): Promise<TranscriptFile | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * The transcript of a session, `<project>/<sessionId>.jsonl`, and those of its subagents,
 * `<project>/<sessionId>/subagents/*.jsonl`, in every project folder. Empty when there is
 * none, such as for an agent other than Claude Code.
 */
export async function findTranscripts(
  projectsDir: string,
  sessionId: string
): Promise<TranscriptFile[]> {
  if (!SESSION_ID.test(sessionId)) return []
  let projects: string[]
  try {
    projects = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const found: TranscriptFile[] = []
  for (const project of projects) {
    const main = await fileInfo(join(projectsDir, project, `${sessionId}.jsonl`))
    if (!main) continue
    found.push(main)
    const subagents = join(projectsDir, project, sessionId, 'subagents')
    let names: string[] = []
    try {
      names = await readdir(subagents)
    } catch {
      // No subagents folder: the session ran none.
    }
    for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
      const info = await fileInfo(join(subagents, name))
      if (info) found.push(info)
    }
  }
  return found
}

/** Changes whenever one of the files grows, is rewritten or is added; short, as it is stored. */
export function stampOf(files: TranscriptFile[]): string {
  const size = files.reduce((sum, f) => sum + f.size, 0)
  const mtime = Math.max(0, ...files.map((f) => f.mtimeMs))
  return `${files.length}:${size}:${Math.round(mtime)}`
}

/**
 * Every session under the projects folder: each `<project>/<id>.jsonl` with its subagents'
 * transcripts. Subagent folders without a main transcript are left out.
 */
export async function listAllSessions(
  projectsDir: string
): Promise<{ sessionId: string; files: TranscriptFile[] }[]> {
  let projects: string[]
  try {
    projects = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const project of projects) {
    let names: string[] = []
    try {
      names = await readdir(join(projectsDir, project))
    } catch {
      continue
    }
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : ''
      if (SESSION_ID.test(id)) ids.add(id)
    }
  }
  const sessions = []
  for (const sessionId of ids) {
    const files = await findTranscripts(projectsDir, sessionId)
    if (files.length > 0) sessions.push({ sessionId, files })
  }
  return sessions
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
