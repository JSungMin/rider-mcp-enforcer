# rider-mcp-enforcer · gamedev-log-analyzer

**English** · [한국어](README.ko.md)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/rider-mcp-enforcer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

> Two Claude Code plugins for large Unreal C++, Unity, and .NET projects. Search the codebase through
> Rider's index instead of `grep`, and read tens-of-MB editor logs without dumping them into the
> conversation. Both cost about 99% fewer tokens than the naive approach.

### Demo

`gamedev-log-analyzer` turning a 6,000-line synthetic engine log into a few hundred tokens
(`summary` / `search` / `locate` / `diff`):

![gamedev-log-analyzer demo](demo/demo.svg)

### What it looks like
```text
# Claude tries to grep code → the hook nudges it toward the Rider index (default `warn`):
$ grep -rn "AMyActor" Source/**/*.cpp
💡 [rider-mcp-enforcer] Heads-up: a code-symbol search via Bash. Prefer search_symbol / search_text
   (or the `code-locator` subagent).   # RIDER_ENFORCE=block to hard-deny instead

▶ search_symbol "AMyActor"
  Source/Game/MyActor.h:42   class MYGAME_API AMyActor : public APawn   (+3 more)
  → ~120 tokens   (grep would have dumped ~14,000)

# A 52 MB editor log → parsed, deduped, classified:
▶ /gamedev-log-analyzer:logs
  41,233 lines · 7 errors · 312 warnings
  ERROR   [LogStreaming] Failed to load asset <addr>         (×128)   @ AssetManager.cpp:210
  WARNING [LogPhysics]   Penetration depth <n> exceeds limit (×4,051) @ MyComponent.cpp:88
  → ~900 tokens   (raw log ≈ 1,300,000)
```
<sub>Illustrative output with placeholder symbols.</sub>

### Sound familiar?
- `grep` on a giant Unreal C++ repo floods the context. Searching through Rider's index instead stays token-capped, around 99% smaller ([benchmarks](#combined-token-savings-measured)).
- A 50 MB editor log is unreadable as-is. Parsing, deduplicating, and classifying it brings it down to about 2,500 tokens.
- Claude keeps reaching for `grep` on code. A hook catches that and points it at the Rider tools.

### Contents
- [Marketplace — two plugins](#marketplace--two-plugins) · [Combined savings](#combined-token-savings-measured) · [Using both together](#using-both-together)
- [What it does](#what-it-does) · [Performance](#performance-measured) · [Editor log analysis](#editor-log-analysis)
- [Prerequisites](#prerequisites) · [Install](#install) · [Setup](#setup--configuration-command) · [Updating](#updating-to-a-new-version)
- [Configuration](#configuration-env) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)

---

A Claude Code plugin that routes symbol search, find-usages, file search, function/variable navigation,
and rename refactoring through JetBrains Rider's live index instead of Bash `grep` and text replace, and
caps the tokens a find-usages flood can spend. It's built for large Unreal C++ (Rider for Unreal) and
.NET/C# codebases, where `grep` is slow and burns context.

Renames go through Rider's `rename_refactoring`, which updates every reference across the project
semantically, so Claude never tries to `sed` a symbol name and break the build on a partial match. See
[Refactoring](skills/rider-search/SKILL.md) in the routing skill.

## Marketplace — two plugins

This repo is a Claude Code plugin marketplace. It holds two plugins built around the same goal: read
big things without paying for all of it in tokens.

| Plugin | Does | Needs |
| --- | --- | --- |
| **rider-mcp-enforcer** (this page) | Steer code search to Rider's MCP symbol/reference/file tools over Bash grep (nudge by default, hard-block opt-in), token-capped | Rider running + MCP |
| **[gamedev-log-analyzer](gamedev-log-analyzer/README.md)** | Parse/dedup/classify huge Unreal/Unity/Godot/MSVC-UBT-MSBuild logs (CLI-first), search + diff + locate + extract scalars | Node only (no IDE) |

One-step install: `rider-mcp-enforcer` declares `gamedev-log-analyzer` as a dependency, so installing it
pulls in both. Each server's `npm install` runs on the first session, so there's no manual setup:
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer   # also auto-installs gamedev-log-analyzer
/reload-plugins                                          # first run auto-installs deps for both
```
Want only the log analyzer? Install it alone: `/plugin install gamedev-log-analyzer@rider-mcp-enforcer`.

### Combined token savings (measured)
| Task | Bash / raw | Plugin | Reduction |
| --- | ---: | ---: | ---: |
| Symbol search on a UE5 repo | ~195,600 tok | ~1,700 tok | **~99%** |
| Read a 57 MB editor log | ~1,250,000 tok | ~2,500 tok | **~99.8%** |
| Search one log trace tag (9,226 hits) | ~690,000 tok | ~1,700 tok | **~99.8%** |

### Using both together
The log analyzer emits `file:line` for each entry; the Rider plugin turns a `file:line` into the
actual symbol/source. A typical loop:
1. `/gamedev-log-analyzer:logs` → find the error/warning and its `file:line`.
2. Hand that location to rider-mcp-enforcer's `get_symbol_info` / `read_file` (or `search_symbol`) to
   open and understand the code — without ever grepping or dumping the raw log.

The handoff also runs the other way: Rider's code index deliberately excludes `Saved/` (logs, build
output), so a search/read aimed at a log returns empty or "not a directory" here. When the proxy sees a
call targeting a log path — or an empty result that might live in the logs — it appends a one-line
pointer back to gamedev-log, so a log-analysis task doesn't get stuck retrying against the code index.

## What it does

Rider 2025.2+ ships an MCP server that exposes (verified live) `search_symbol`, `search_file`,
`search_text`, `search_regex`, `find_files_by_name_keyword`, `find_files_by_glob`, `get_symbol_info`,
`rename_refactoring`, `read_file`, and ~20 more. This plugin adds the layer that makes Claude
actually use them instead of grep:

| Layer | File | Effect |
| --- | --- | --- |
| **Enforcement hook** | `hooks/block-code-grep.js` | Intercepts Bash `grep`/`rg`/`find -name`/`git grep` **and the built-in Grep tool** over C/C++/C# source, steering Claude to the Rider MCP tools. **Bash: default `warn`** — the command runs but a nudge is injected into the model's context; `RIDER_ENFORCE=block` hard-denies, `=0` disables. **Grep tool: warn-only, never blocks** — it's the right fallback on a just-edited/unindexed file Rider hasn't reindexed, so it's only nudged (on an explicit code glob/type/path); `=0` silences it. MCP search and the Read tool still bypass by design. Non-code text (logs, md, json) passes through. |
| **`code-locator` subagent** | `agents/code-locator.md` | Delegate "where is X / what calls Y / find file W" to a context-isolated subagent that uses Rider's index internally and returns only a compact `file:line` table — the raw matches never enter your context. The accuracy + token win without any hook friction. |
| **Routing skill** | `skills/rider-search/SKILL.md` | Karpathy-style rules: symbol/file/text lookups → Rider tools first; grep is last resort. |
| **Summarizing proxy** | `proxy/` | An MCP server fronting Rider's MCP. Parses the JSON search responses (`{items:[{filePath,startLine,lineText}],more}`) into compact `path:line  text`, capped at `RIDER_MAX_RESULTS`, and injects a default `projectPath`. Stops large-codebase result floods from blowing up context. |

> To be clear about scope: Rider's MCP already does symbol and file search on its own. What this plugin
> adds on top is the enforcement, the token cap, and the projectPath handling.

### Subagents

Each plugin also ships a subagent you can hand a whole task to. It does the reading or searching in its
own separate context and returns only the answer, so the raw log lines or source matches never land in
your main context. Since that context is separate rather than a gate the way the hook is, nothing slips
past it, and a single-purpose agent usually beats the main session for accuracy.

| Subagent | Use it for | Returns |
| --- | --- | --- |
| `gamedev-log-analyzer:log-analyst` | "analyze this log", "what errors/warnings", "what changed", "track this scalar", "which warnings by code" | A compact severity / dedup / code-rollup / `file:line` answer (no raw log lines) |
| `rider-mcp-enforcer:code-locator` | "where is X defined", "what calls Y", "all usages of Z", "find file W" (C#/.NET or Unreal C++ in Rider) | A tight `kind name @ file:line` table (no source bodies) |

You don't invoke them by hand. Ask "analyze `Editor.log`" or "find usages of `AMyActor`" and Claude
picks the right one from its description; naming it explicitly also works. A 3,000-line log comes back
as roughly 300 tokens, a repo-wide search as a few dozen `file:line` rows. `code-locator` needs Rider's
MCP connected; `log-analyst` runs on Node alone.

### Commands & tools
- `/rider-mcp-enforcer:setup` — configure the plugin (see [Setup](#setup--configuration-command)).
- `/rider-mcp-enforcer:savings` — show cumulative token savings.
- `/rider-mcp-enforcer:discover` — scan local Claude Code transcripts for code searches that bypassed
  rider-search and report the aggregate missed savings + a coverage ratio (local-only; no paths/commands/
  code in the output). CLI: `node "<plugin>/proxy/discover.mjs"` (run from your project root).
- MCP tools (server `rider-search`): `rider_setup`, `rider_config`, `rider_detect`, `rider_savings`,
  `rider_savings_reset`, `rider_regen_project`, the summarized Rider search tools (`search_symbol`,
  `search_text`, …), and the Rider refactor tools (`rename_refactoring`, `move_type_to_namespace`,
  `reformat_file`).

When a search returns "doesn't exist"/empty for a file that *is* on disk, the project files are stale
(source added/moved/renamed since the last generation) and Rider can't index it. The proxy flags that
case and points at a regenerate step. It is **dry-run-first**: nothing runs until you confirm.

- **`rider_regen_project` MCP tool** — a call without `confirm` shows the plan (resolved `.uproject`,
  engine, and exact command); `confirm:true` runs it. Because it spawns a build, Claude Code asks you to
  approve the tool the first time (expected).
- **No-approval alternative — the CLI** (`/rider-mcp-enforcer:regen`): run it yourself so there's no MCP
  shell-approval prompt — `node "<plugin>/proxy/regen.mjs"` (dry run) then `--confirm`. Pin a wrong
  default with `RIDER_REGEN_CMD`/`RIDER_ENGINE_PATH`. Auto-detect is Windows-only.

**After a successful regen, Rider must reload the solution** (accept its prompt, or **File → Reload All
from Disk** / Unreal **Refresh**) before the symbol index updates and `search_symbol`/`rename_refactoring`
resolve the new files — exiting 0 means the generator ran, not that Rider re-indexed. (Rider exposes no
reload trigger, so the plugin can't click it for you.) Pass `verifyPath:"<the file that was missing>"` to
the **MCP tool** and, after a confirmed regen, it re-probes Rider and reports whether the reload took
(**✓** visible / **✗** still missing → reload and retry). Verification needs Rider connected, so it's
MCP-tool-only (not the CLI).
>
> **Two real limitations of this Rider MCP build (verified live):**
> 1. **No semantic find-usages/find-references tool.** Reference-finding falls back to `search_text`/
>    `search_regex` (indexed string match, not semantic).
> 2. **`search_symbol` on Unreal C++ can be weak** — it may return filename/path matches (e.g. `.Build.cs`)
>    rather than the exact class. Verify results; fall back to `search_text` when a symbol hit looks off.

## Performance (measured)

Real A/B on a large UE5 project — finding one class name (~2,400 textual occurrences) via Bash grep
vs this plugin. No project source is reproduced; see [BENCHMARK.md](BENCHMARK.md) for method.

| | Bash grep (whole repo) | Bash grep (game dir) | **Plugin (Rider MCP, summarized)** |
| --- | ---: | ---: | ---: |
| Tokens to the model | ~195,600 | ~114,100 | **~1,700** |
| Wall time | 55,006 ms | 382 ms | **~870 ms** |

- Tokens: 98–99% fewer (67–115×), every time. About 87% of that comes from summarizing the response,
  the rest from the cap.
- Time: ~63× faster when grep would otherwise scan the whole repo, Engine included. It runs a little
  slower than a grep you've already narrowed, since the MCP call carries a fixed SSE round-trip and
  ripgrep is very fast on a small scope.

### Accuracy difference (and why)
This is a precision/recall trade-off, not a case of one being more correct than the other:
- **Recall:** the plugin returns the top `N` (cap), not all 2,400+ hits. The withheld ~98% are mostly
  comments/includes/substring noise. Need an exhaustive list? Raise `RIDER_MAX_RESULTS` or use grep.
- **Precision:** grep matches every substring (a `Foo` query also hits `FooBar`), over-reporting ~100×
  here; the plugin's symbol search returned 25 distinct candidate files.
- **Known weakness:** on Unreal C++, `search_symbol` may point at a file's line 1 rather than the exact
  declaration (Rider indexing limit). `search_text` gives the real `file:line  code`; the skill tells
  Claude to prefer it when a symbol hit looks off.

> So: for navigation (a definition plus representative usages) the plugin is both more accurate and far
> cheaper. For an exhaustive occurrence audit, raise the cap or fall back to grep on purpose.

### Incomplete results (correctness guard)
Capping saves tokens but it's dangerous for "find ALL references", where a missed call site means
wrong code. So truncation is never silent:

1. When the first fetch looks truncated, the proxy **auto-retries once** with a larger limit
   (`RIDER_ESCALATE_LIMIT`) to learn the true count.
2. If the set is still not exhaustive, the response carries a loud `⚠ INCOMPLETE RESULTS — showing X
   of Y+` banner with three options: **raise the cap**, **narrow scope (`paths`)**, or **confirm a
   partial set is acceptable**.
3. The skill instructs Claude: for references/refactor/rename, **stop and ask the user** with those
   options instead of acting on the partial list.

## How much did it save? (token-savings command)

Each summarized search also appends a per-call line — `✓ Saved ~N tokens here (Rider index, summarized
vs raw response)` — whenever the win is non-trivial, so the payoff is visible in the moment (and its
absence is a hint the result was already small). The proxy records the same numbers cumulatively. Check
the running total any of these ways:

- **In Claude Code:** run `/rider-mcp-enforcer:savings` (or just ask "how much has the plugin saved?").
  It calls the `rider_savings` MCP tool.
- **From a shell:** `node <plugin-dir>/proxy/stats.mjs`
- **Reset:** call the `rider_savings_reset` tool.

Example output:
```
rider-mcp-enforcer — cumulative token savings (vs forwarding Rider's raw responses)
  summarized calls : 1
  raw tokens       : ~30,398
  sent tokens      : ~362
  saved            : ~30,036 (99%)
  noise items dropped (build artifacts): 78
```
> "Saved" here is vs Rider's *raw* response. Savings vs **Bash grep** are typically far larger — see
> [BENCHMARK.md](BENCHMARK.md).

## VCS output compaction (git / p4)

A read-only `git status` / `git log` / `git diff` (or `p4 opened` / `status` / `changes` / `reconcile`)
can dump hundreds of repetitive, mostly-boilerplate lines into the context. The hook transparently reroutes
a single such command to a compacting wrapper (`proxy/vcs.mjs`) that **runs the real command** and then
groups, deduplicates, and caps the output — `git status` → counts per change-type + top dirs, `git log` →
one line per commit, `git diff` → a per-file `+adds/-dels` diffstat (hunks dropped).

This is the *safe* rewrite class. Unlike code search — which targets Rider's MCP and so can't be a
Bash→Bash rewrite — `git`/`p4` are local CLIs that always work, so the rewrite can never strand you: the
command still runs, you just get the compacted output. It never blocks. A non-zero exit or empty output passes the real command's stdout/stderr through untouched, so a
"not a git repo" / auth error surfaces verbatim.

Anything ambiguous — a pipeline, shell quoting, a `$`/redirect, a global flag before the subcommand
(`git -C path status`), or a non-read-only subcommand (`git commit`) — is left exactly as you typed it; a
rewrite is never a guess. `git grep` stays a **code** search (routed to the Rider tools, not compacted).
Disable with `RIDER_COMPACT_VCS=0`; cap with `RIDER_VCS_MAX` (default 60).

## Prerequisites

- **JetBrains Rider 2025.2+**, running, with the project open.
- **Node.js ≥ 18** on PATH.
- Rider MCP enabled: **Settings | Tools | MCP Server → Enable MCP Server**, then **Copy SSE Config**.

## Install

```bash
# 1) Add the marketplace and install (also auto-installs gamedev-log-analyzer)
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer
/reload-plugins        # first run auto-installs the server deps (no manual npm)

# 2) Configure it — from inside Claude Code, just run:
/rider-mcp-enforcer:setup
#   It detects Rider's SSE endpoint, asks for the project path, and writes the config.
```

Verify the `rider-search` MCP server and its tools appear, and that a `grep src/**/*.cpp` triggers a
nudge toward the Rider tools (or is denied under `RIDER_ENFORCE=block`). (The `npm install` for each
plugin's MCP server runs automatically on session start via a hook into `${CLAUDE_PLUGIN_DATA}`.)

## Setup / configuration command

You don't edit OS environment variables. Settings live in a config file
(`~/.rider-mcp-enforcer/config.json`) the proxy reads at startup. Configure it any of these ways:

- **In Claude Code (recommended):** `/rider-mcp-enforcer:setup` — guided: it runs `rider_detect`,
  asks for `projectPath`, and applies via the `rider_setup` tool. Then `/reload-plugins`.
- **Ad-hoc via tools:** ask Claude to call `rider_setup { "riderSseUrl": "...", "projectPath": "..." }`,
  `rider_config` (show current), or `rider_detect` (probe the port).
- **From a shell:**
  ```bash
  node <plugin-dir>/proxy/setup.mjs --detect
  node <plugin-dir>/proxy/setup.mjs riderSseUrl=http://127.0.0.1:<port>/sse projectPath="G:/Path/To/Project"
  node <plugin-dir>/proxy/setup.mjs --show
  ```

Settings are read at proxy startup → **run `/reload-plugins` after changing them**. Precedence:
**environment variable > config file > built-in default** (so a same-named env var still wins).

## Updating to a new version

Claude Code caches the marketplace repo, so new commits are **not** auto-fetched. To pull a newer
version of this plugin:

```bash
# 1) Refresh the cached marketplace catalog
/plugin marketplace update rider-mcp-enforcer

# 2) Update the installed plugin (or uninstall + install to be sure)
/plugin update rider-mcp-enforcer
#   fallback: /plugin uninstall rider-mcp-enforcer  then  /plugin install rider-mcp-enforcer@rider-mcp-enforcer

# 3) Reload so the new hook/command/MCP server take effect (deps auto-reinstall on session start)
/reload-plugins        # or restart Claude Code
```

Check what's installed with `/plugin` (it lists each plugin's version). If a command like
`/rider-mcp-enforcer:setup` is missing, your installed copy predates it — update as above.

> Maintainer note: the `version` field in `.claude-plugin/plugin.json` gates updates — bump it when
> you want clients to pick up changes. Config keys/commands/tools must be updated in the same commit as
> any source change; version history lives in [Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)
> (auto-generated on each `v*` tag), not in this README.
>
> **Release/version sync:** the git tag equals the **headline plugin** version — every release bumps
> `rider-mcp-enforcer` (plugin.json + marketplace.json) to `X.Y.Z` and tags `vX.Y.Z` (identical), so
> `/plugin update rider-mcp-enforcer` always delivers the latest bundle. Because changes often land in
> the bundled `gamedev-log-analyzer` (which keeps its own independent semver), the headline plugin must
> still bump on those releases — otherwise clients see "already at latest" and never receive the update.

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `RIDER_MCP_SSE_URL` | — (required) | Rider MCP SSE URL from "Copy SSE Config". Without it the proxy returns setup instructions and Claude falls back to grep. |
| `RIDER_MAX_RESULTS` | `50` | Max `file:line` lines kept per summarized response. |
| `RIDER_SUMMARIZE_TOOLS` | _(auto)_ | Optional **restrict** filter — comma list of tool names allowed to be summarized. By default the proxy summarizes **any list-shaped response** (decided by response shape, not name), so non-list tools like `read_file` are never touched and Rider tool renames need no config. |
| `RIDER_PROJECT_PATH` | — | Default project path the proxy injects when a tool call omits `projectPath`. Set this when multiple projects are open in Rider (otherwise Rider errors "Unable to determine the target project"). Get it from the "Currently open projects" list in that error, or the project root. |
| `RIDER_ESCALATE` | `1` | `0`/`false`/`off` disables auto-escalation (see below). |
| `RIDER_ESCALATE_LIMIT` | `500` | When a result looks truncated, the proxy re-fetches once with this larger limit to learn the true count. |
| `RIDER_MAX_LINE_CHARS` | `200` | Max chars of each match's code snippet (prevents one giant generated line from blowing the budget). |
| `RIDER_EXCLUDE` | `/intermediate/,/binaries/,/build/,/saved/,/deriveddatacache/,/.vs/,/.idea/,/node_modules/,.vcxproj,.sln,.filters` | Comma list of case-insensitive path substrings dropped from results (build artifacts / generated noise). |
| `RIDER_EXCLUDE_OFF` | `0` | `1`/`true`/`on` keeps the excluded paths in results. |
| `RIDER_STATS_FILE` | `~/.rider-mcp-enforcer/stats.json` | Where the cumulative token-savings ledger is written. |
| `RIDER_ENFORCE` | `warn` | `warn` (default) = run the command + inject a nudge; `block` = hard-deny (**Bash only** — the Grep tool is always warn-only, never blocked); `0`/`off` = disable the hook entirely. |
| `RIDER_EXCLUDE_COMMANDS` | — | Comma list of executables (`grep`/`rg`/`ack`/`ag`/`findstr`/`find`/`git`) the hook leaves alone — finer than the global `RIDER_ENFORCE=0`. Also settable as `excludeCommands` (array) in config.json. |
| `RIDER_COMPACT_VCS` | `1` | `0`/`off` disables the read-only `git`/`p4` output-compaction rewrite (see [VCS output compaction](#vcs-output-compaction-git--p4)). |
| `RIDER_VCS_MAX` | `60` | Max grouped lines kept in a compacted `git`/`p4` result. |
| `RIDER_REGEN_CMD` | — | `rider_regen_project`: explicit regen command template (`{uproject}`/`{engine}` tokens), bypassing auto-detect. Set this if auto-detect picks the wrong command (or on macOS/Linux). |
| `RIDER_ENGINE_PATH` | — | `rider_regen_project`: Unreal engine directory, overriding registry auto-detection. |
| `RIDER_REGEN_TIMEOUT` | `300000` | `rider_regen_project`: max milliseconds a regen may run before it's killed. |

## How enforcement works

- The **hook** runs before every Bash call. If the command is a code-symbol search (grep/rg/ack/ag/
  findstr, `find -name`, or `git grep` — which scans the tracked source tree by default) targeting
  `*.cpp/.h/.cs/...` or `src|source|engine/`, and is *not* aimed at a log/md/json/build path, it nudges
  (or, under `RIDER_ENFORCE=block`, exits non-zero) toward the Rider tool. Otherwise it allows the
  command. The first time you trigger it before configuring the plugin, the nudge also points at
  `/rider-mcp-enforcer:setup`.
- The **skill** biases Claude toward the Rider tools proactively.
- The **proxy** guarantees the token cap regardless of how Claude calls the tool.

## Enable Rider MCP first (it's off until you turn it on)

The Rider MCP server isn't active by default in every build, and a lot of people have it disabled
without realizing it, which makes the plugin look like it does nothing. Turn it on and find its URL:

1. Rider → **Settings | Tools | MCP Server**.
2. Tick **Enable MCP Server**. (If you don't see this page, update to Rider **2025.2+**.)
3. In **Manual Client Configuration**, click **Copy SSE Config** (or Copy Stdio Config).
4. From the copied config, take the SSE URL and set it:
   ```bash
   export RIDER_MCP_SSE_URL="http://localhost:<port>/sse"   # macOS/Linux
   $env:RIDER_MCP_SSE_URL = "http://localhost:<port>/sse"   # PowerShell
   ```
   The port is **per-instance** (often in the 63342/64342 range, but do not hardcode — copy it).
5. Restart Claude Code (or `/reload-plugins`).

### Verify it's actually on
```bash
# Is Rider serving the MCP SSE endpoint? 200/SSE = good, connection refused = disabled/wrong port.
curl -i -m 3 "$RIDER_MCP_SSE_URL"
```
In Claude Code, the `rider-search` server should list real Rider tools (`find_symbol`,
`find_references`, …). If it only lists a single `rider_status` tool, the proxy could **not** reach
Rider — MCP is off or the URL is wrong.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `rider-search` only shows a `rider_status` tool | Proxy can't reach Rider (MCP disabled or wrong URL) | Enable MCP (above), set/correct `RIDER_MCP_SSE_URL`, restart. |
| Tool call returns "rider-search-proxy is not connected to Rider" | `RIDER_MCP_SSE_URL` unset/unreachable | Set it from **Copy SSE Config**; confirm with `curl`. |
| Tool returns "Unable to determine the target project" | Multiple projects open in Rider, no `projectPath` | Set `RIDER_PROJECT_PATH` to the project root (the error lists open projects), or pass `projectPath` per call. |
| Tool returns "`projectPath`=… doesn't correspond to any open project" | The project is **not open in Rider** | Rider MCP only searches projects open in the IDE. Open the project in Rider (it must finish indexing), then retry. The error lists the currently-open projects. |
| Code search nudged when you wanted plain grep | The hook is steering you to Rider | Default `warn` still **runs** the command — just heed or ignore the nudge. To silence it entirely: `RIDER_ENFORCE=0`. |
| `RIDER_ENFORCE=block` denies a search while Rider is unavailable | You opted into hard-block but MCP is off | Set `RIDER_ENFORCE=0` (or back to `warn`) until MCP is on. |
| Wrong/empty summaries | Rider tool name differs from defaults, or unusual response shape | Set `RIDER_SUMMARIZE_TOOLS` to your build's tool names; tune `RIDER_MAX_RESULTS`. |
| `curl` to the SSE URL refuses connection | Rider not running, MCP off, or wrong port | Start Rider, enable MCP, re-copy the SSE config. |
| `Dependency "gamedev-log-analyzer@rider-mcp-enforcer" is not found in any configured marketplace` (Plugin Errors panel) | **Stale marketplace cache** after the `ue-log-analyzer`→`gamedev-log-analyzer` rename: the updated `plugin.json` names the new dependency, but your cached catalog still lists the old one | Refresh the catalog, then reload: `/plugin marketplace update rider-mcp-enforcer` → `/reload-plugins` (restart Claude Code if the panel still shows it). A leftover `ue-log-analyzer` install is harmless — remove it with `claude plugin prune`. |

> **MCP off?** No footgun by default — the hook's default `warn` always lets grep run, so Claude can
> still search even when Rider's MCP is unavailable. Only `RIDER_ENFORCE=block` would deny it; set
> `RIDER_ENFORCE=0` (or `warn`) in that case.

## Status / caveats

- **Live-verified against Rider 2025.2.3.** `search_text` and `search_symbol` are confirmed working on
  a real Unreal Engine 5 project — the [benchmark](BENCHMARK.md) numbers were measured through them.
  Tool names target Rider 2025.2+; if your build names a tool differently, check the `rider-search`
  tool list and set `RIDER_SUMMARIZE_TOOLS`.
- The summarizer is heuristic (keeps `path:line`-looking lines). Tune `RIDER_MAX_RESULTS` per repo.
- Transport is SSE. If your Rider build only offers stdio, open an issue — a stdio client mode can be
  added.

## Permissions & safety

Everything runs locally and nothing is uploaded:

- The **hook** (`PreToolUse` on Bash) only inspects the command string to decide whether to redirect a
  code-grep to Rider — it does not read file contents or run anything. It honors `RIDER_ENFORCE=0`.
- The **proxy** connects only to Rider's MCP SSE endpoint on `localhost` and forwards/summarizes
  search responses. It opens no outbound internet connections and writes only its config + a local
  token-savings ledger under `~/.rider-mcp-enforcer/`.
- **gamedev-log-analyzer** reads local log files you point it at and prints summaries.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Version history

See the **[Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)** page — every version
tag publishes categorized, PR-linked notes (🚀 Features / 🐛 Bug Fixes / 📝 Documentation / 🔧
Maintenance), generated automatically. The badge at the top always points at the latest.

## Contributing

Issues and PRs welcome — bug reports, new log formats/engines, additional Rider tool mappings, or docs.

This repo is maintained with AI-assisted review, so PRs are judged from the diff, description, and
evidence. Keep them small, clearly described, backed by evidence, and free of any proprietary data.
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

If this saved you tokens or debugging time, a star helps others find it. ⭐

## Privacy

These plugins collect no personal data and process everything locally — see [PRIVACY.md](PRIVACY.md).

## License

MIT © 2026 JSungMin
