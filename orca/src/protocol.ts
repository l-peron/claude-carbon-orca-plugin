// The panel <-> worker contract, declared once: src/panel.ts and src/worker.ts both read it.
import type { CarEquivalence } from './carbon/equiv.ts'
import type { Focus, Summary } from './history.ts'
import type { Insights } from './insights.ts'

export type EquivalenceSet = 'fr' | 'us' | 'world'

/** The import of every transcript already on disk. */
export type BackfillState = {
  running: boolean
  /** Sessions looked at so far, of `total`. */
  done: number
  total: number
  /** Sessions computed (new or changed) in this run. */
  imported: number
  /** When the last full run ended, ms since epoch; null before the first. */
  finishedAt: number | null
}

export type CarbonState = Summary & {
  /** The folder factors.json and prices.json came from; null for the built-in defaults. */
  dataSource: string | null
  /** The workspace Orca has in focus and its Claude Code sessions; null when none is focused. */
  focus: Focus | null
  insights: Insights
  /** factors.json's car equivalence per set; a set is missing when it has none. */
  cars: Partial<Record<EquivalenceSet, CarEquivalence>>
  /** The set the worker's locale names (LC_ALL, LC_MESSAGES, LANG); null when none does. */
  envSet: EquivalenceSet | null
  backfill: BackfillState
}

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace, today, the history and the import, from what the worker stored. */
    'carbon.summary': { output: CarbonState }
    /** Shows `sessionId` for the workspace from now on, remembered in storage. */
    'carbon.pick': { input: { workspaceId: string; sessionId: string }; output: CarbonState }
    /** Imports every transcript on disk again, skipping unchanged ones; false when one runs. */
    'carbon.reimport': { output: { started: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after a session is stored or the focus moves. */
    'carbon.changed': CarbonState
    /** Posted while the import runs. */
    'carbon.progress': BackfillState
  }
}
