# Claude Carbon for Orca

A community port of [claude-carbon](https://github.com/gwittebolle/claude-carbon) to
[Orca](https://github.com/stablyai/orca). It is not an official claude-carbon or Orca plugin.
It shows the CO₂ and the API-equivalent cost of the Claude Code sessions you run in Orca, in a
sidebar panel and in the status bar. It uses the same factors, prices, formulas and transcript
parsing as claude-carbon, read from this repository's `data/`.

<p>
  <img src="docs/current-session.png" width="320" alt="The Current session card: 196 gCO₂e and $6.55 API-equivalent for the session 'Add dark mode' in the workspace my-app, about 0.98 km driven by car, 0.6 times the median session, and its token counts">
  <img src="docs/history.png" width="320" alt="The History card over 30 days: 34.18 kgCO₂e, $1094 and 72 sessions, a bar chart of CO₂ per day with a kgCO₂e axis, and bars by model and by workspace">
</p>

The screenshots use made-up sessions (`docs/render-shots.mts`), with the panel's own HTML.
`docs/panel-dark.png` shows the whole panel in a dark theme.

## What it shows

- **Current session**, for the workspace Orca has in focus. It shows the session's CO₂ (large),
  its API-equivalent cost, a car-distance equivalent from `data/factors.json`, how it compares
  with your median session, the tokens and the CO₂ per model. When the workspace has several
  Claude Code sessions, a picker chooses one: by default the most recently active one, and your
  choice is kept per workspace.
- **History**, over 7 days, 30 days, 90 days or all time. It shows total CO₂, cost and sessions,
  a bar per day (today's bar is stronger) on a gCO₂e or kgCO₂e axis, and the split by model and
  by workspace. Hover over a day to see its CO₂ and cost.
- **Status bar**: the latest session's CO₂ and today's total.

Every amount reads as a number and its unit, `gCO₂e` or `kgCO₂e`.

## How it works

The plugin is a trusted worker and an HTML panel; it has no build step.

- When a Claude Code agent in Orca finishes a turn (`agent.status.changed`, state `done`), the
  worker reads `~/.claude/projects/*/<sessionId>.jsonl` and the session's subagent transcripts.
  It sums the assistant `usage` per model and day, then prices it with claude-carbon's
  `co2.ts` and `cost.ts`.
- When a workspace comes into focus (`workspace.changed`), the worker lists its agents
  (`agents.list`) and computes any session it has not stored yet.
- On its first run, the worker imports every transcript already on disk, in the background.
  **Re-import history** in the panel runs the import again. A session whose files have not
  changed is skipped.
- The worker stores one small record per session in the plugin's own storage (totals, per model,
  per day). A session is recomputed from its whole transcript, so storing it twice keeps one
  record.

## Install

Needs Orca 1.4.248 or newer, with plugins turned on (Settings → Plugins).

```sh
git clone https://github.com/l-peron/claude-carbon-orca-plugin.git
orca plugin dev load <path>/claude-carbon-orca-plugin/orca --json
```

The first `dev load` stops with `approval_required` (exit 3). It prints the access the plugin
asks for and a fingerprint. If you agree, run the same command again with that fingerprint:

```sh
orca plugin dev load <path>/claude-carbon-orca-plugin/orca --json --approve <fingerprint>
orca plugin open local.claude-carbon --panel carbon
```

The plugin asks for:

- **trusted-worker**: its own Node.js process, which runs with your user's access to your files.
  The plugin uses this access to read `~/.claude/projects` and `data/`.
- **`agent:read`**: to be notified when an agent's status changes.
- **`workspace:read`**: to know the focused workspace and its agents.
- **`storage:own`**, **`settings:own`**: its own storage and settings.

## Settings

- **Claude Code transcripts folder** (`projectsDir`): if empty, the plugin uses
  `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when that variable is not set.
- **Factors folder** (`dataDir`): if empty, the plugin uses this repository's `data/`
  (`../data` from `orca/`), or a `data/` folder beside the plugin when you copy `orca/` alone.
  When neither exists, it uses claude-carbon's built-in defaults.

## Limits

- Only Claude Code sessions are counted. Other agents have no transcript under
  `~/.claude/projects`, so the worker skips them.
- Orca's plugin API gives the focused workspace, not the focused chat or terminal tab. So the
  panel follows the workspace and offers a picker when the workspace has several sessions.
- The worker records a session when a turn ends, so the panel lags behind a turn that is still
  running.
- Imported sessions are named in the history by the folder Claude Code ran in, until Orca shows
  them in a focused workspace.
- Within a period, the split by model is estimated: the period's CO₂ is divided in the same
  ratio as the session's model split.
- The car equivalence uses the set that your locale names (`LC_ALL`, `LC_MESSAGES`, `LANG`).
  If none is set, it uses the French set for a French Orca, else the world set.
- The status bar item works only in the Orca desktop app.

## Layout

```
orca/
  orca-plugin.json   the manifest
  src/carbon/        the CO₂ and cost math; no Orca or Node API
    co2.ts, cost.ts, equiv.ts   copied unchanged from hooks/mod/lib/ (MIT header kept)
    palette.ts       classOf from hooks/mod/lib/mascot.ts, and a median
    transcript.ts    transcript usage, ported from CC_JQ_FILE_USAGE (scripts/portable-lib.sh)
    session.ts       per-session totals per model and day
  src/files.ts       Node file access: transcripts, factors and prices; no Orca API
  src/history.ts     stored records, the summary, the focused workspace
  src/insights.ts    history per period: totals, days, by model, by workspace
  src/view.ts        the panel's HTML and CSS as strings, tested in Node
  src/panel.ts       the HTML panel: puts view.ts on the page, handles clicks
  src/worker.ts      the worker: events, import, storage, status bar, panel requests
  src/protocol.ts    the panel and worker contract
  docs/              screenshots and the script that renders them
```

## Develop

From `orca/`:

```sh
orca plugin types .           # writes .orca/types/ for tsc
npx -p typescript tsc -p .    # type-check
orca plugin test . --json     # the math (against tests/methodology-vectors*.json), parsing,
                              # history, view, worker
orca plugin validate . --json
orca plugin check . --json
node --experimental-strip-types docs/render-shots.mts /tmp/shots   # screenshot pages
```

## Credits and license

The factors, prices, methodology, golden vectors, `co2.ts`, `cost.ts`, `equiv.ts` and the
palette come from [claude-carbon](https://github.com/gwittebolle/claude-carbon) by Gaëtan
Wittebolle, under the MIT License (see `LICENSE` at the repository root). The copied files keep
their MIT notice. The Orca plugin code is under the same license.
