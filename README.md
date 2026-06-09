# rider-mcp-enforcer · ue-log-analyzer

**English** · [한국어](README.ko.md)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/rider-mcp-enforcer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

> **Read big things cheaply.** A two-plugin Claude Code marketplace for large **Unreal C++ /
> Unity / .NET** projects: search the codebase through **Rider's index** instead of `grep`, and
> analyze **tens-of-MB editor logs** — both at **~99% fewer tokens**.

### What it looks like
```text
# Claude tries to grep code → the hook blocks it and redirects:
$ grep -rn "AMyActor" Source/**/*.cpp
⛔ [rider-mcp-enforcer] Blocked a code-symbol search. Use search_symbol / search_text instead.

▶ search_symbol "AMyActor"
  Source/Game/MyActor.h:42   class MYGAME_API AMyActor : public APawn   (+3 more)
  → ~120 tokens   (grep would have dumped ~14,000)

# A 52 MB editor log → parsed, deduped, classified:
▶ /ue-log-analyzer:logs
  41,233 lines · 7 errors · 312 warnings
  ERROR   [LogStreaming] Failed to load asset <addr>         (×128)   @ AssetManager.cpp:210
  WARNING [LogPhysics]   Penetration depth <n> exceeds limit (×4,051) @ MyComponent.cpp:88
  → ~900 tokens   (raw log ≈ 1,300,000)
```
<sub>Illustrative output with placeholder symbols.</sub>

### Is this you?
- 🔍 **`grep` floods your context** on a giant Unreal C++ repo → search via Rider's index, token-capped (**~99% fewer tokens** — see [benchmarks](#combined-token-savings-measured)).
- 🪵 **A 50 MB editor log is unreadable** → parse, deduplicate, and classify it down to **~2,500 tokens**.
- 🤖 **Claude keeps `grep`-ing code** → a hook automatically **redirects it to the Rider tools**.

### Contents
- [Marketplace — two plugins](#marketplace--two-plugins) · [Combined savings](#combined-token-savings-measured) · [Using both together](#using-both-together)
- [What it does](#what-it-does) · [Performance](#performance-measured) · [Editor log analysis](#editor-log-analysis)
- [Prerequisites](#prerequisites) · [Install](#install) · [Setup](#setup--configuration-command) · [Updating](#updating-to-a-new-version)
- [Configuration](#configuration-env) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Changelog](#changelog)

---

A **Claude Code plugin** that makes Claude do symbol search, find-usages, file search, and
function/variable navigation through **JetBrains Rider's live index** instead of Bash `grep` —
and *enforces* it, while capping the tokens a find-usages flood can spend.

Built for large **Unreal C++ (Rider for Unreal)** and **.NET/C#** codebases, where `grep` is slow
and burns context.

## Marketplace — two plugins

This repo is a Claude Code **plugin marketplace** with two installable plugins that share one idea —
**read big things cheaply**:

| Plugin | Does | Needs |
| --- | --- | --- |
| **rider-mcp-enforcer** (this page) | Force Rider's MCP symbol/reference/file search over Bash grep, token-capped | Rider running + MCP |
| **[ue-log-analyzer](ue-log-analyzer/README.md)** | Parse/dedup/classify huge UE/Unity editor logs, search + extract scalars | Node only (no IDE) |

**One-step install** — `rider-mcp-enforcer` declares `ue-log-analyzer` as a dependency, so installing
it pulls in both, and each server's `npm install` runs automatically on first session (no manual setup):
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer   # also auto-installs ue-log-analyzer
/reload-plugins                                          # first run auto-installs deps for both
```
Want only the log analyzer? Install it alone: `/plugin install ue-log-analyzer@rider-mcp-enforcer`.

### Combined token savings (measured)
| Task | Bash / raw | Plugin | Reduction |
| --- | ---: | ---: | ---: |
| Symbol search on a UE5 repo | ~195,600 tok | ~1,700 tok | **~99%** |
| Read a 57 MB editor log | ~1,250,000 tok | ~2,500 tok | **~99.8%** |
| Search one log trace tag (9,226 hits) | ~690,000 tok | ~1,700 tok | **~99.8%** |

### Using both together
The log analyzer emits `file:line` for each entry; the Rider plugin turns a `file:line` into the
actual symbol/source. A typical loop:
1. `/ue-log-analyzer:logs` → find the error/warning and its `file:line`.
2. Hand that location to rider-mcp-enforcer's `get_symbol_info` / `read_file` (or `search_symbol`) to
   open and understand the code — without ever grepping or dumping the raw log.

## What it does

Rider 2025.2+ ships an MCP server that exposes (verified live) `search_symbol`, `search_file`,
`search_text`, `search_regex`, `find_files_by_name_keyword`, `find_files_by_glob`, `get_symbol_info`,
`rename_refactoring`, `read_file`, and ~20 more. This plugin adds the layer that makes Claude
actually use them instead of grep:

| Layer | File | Effect |
| --- | --- | --- |
| **Enforcement hook** | `hooks/block-code-grep.js` | Blocks Bash `grep`/`rg`/`find -name` over source files and redirects Claude to the Rider MCP tools. Non-code text searches (logs, md, json) pass through. Set `RIDER_ENFORCE=0` to disable. |
| **Routing skill** | `skills/rider-search/SKILL.md` | Karpathy-style rules: symbol/file/text lookups → Rider tools first; grep is last resort. |
| **Summarizing proxy** | `proxy/` | An MCP server fronting Rider's MCP. Parses the JSON search responses (`{items:[{filePath,startLine,lineText}],more}`) into compact `path:line  text`, capped at `RIDER_MAX_RESULTS`, and injects a default `projectPath`. Stops large-codebase result floods from blowing up context. |

> Honest scope: Rider's MCP alone already gives you symbol/file search. This plugin's value is
> **enforcement + token control + projectPath ergonomics** on top of it.

### Commands & tools
- `/rider-mcp-enforcer:setup` — configure the plugin (see [Setup](#setup--configuration-command)).
- `/rider-mcp-enforcer:savings` — show cumulative token savings.
- MCP tools (server `rider-search`): `rider_setup`, `rider_config`, `rider_detect`, `rider_savings`,
  `rider_savings_reset`, plus the summarized Rider search tools (`search_symbol`, `search_text`, …).
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

- **Tokens: ~98–99% fewer (~67–115×)** — always. ~87% from response summarization, the rest from capping.
- **Time: ~63× faster** when grep would scan the whole repo (incl. Engine); slightly slower than a
  pre-narrowed grep (MCP has fixed SSE round-trip overhead, ripgrep is very fast on a small scope).

### Accuracy difference (and why)
It's a **precision/recall trade**, not "one is more correct":
- **Recall:** the plugin returns the top `N` (cap), not all 2,400+ hits. The withheld ~98% are mostly
  comments/includes/substring noise. Need an exhaustive list? Raise `RIDER_MAX_RESULTS` or use grep.
- **Precision:** grep matches every substring (a `Foo` query also hits `FooBar`), over-reporting ~100×
  here; the plugin's symbol search returned 25 distinct candidate files.
- **Known weakness:** on Unreal C++, `search_symbol` may point at a file's line 1 rather than the exact
  declaration (Rider indexing limit). `search_text` gives the real `file:line  code`; the skill tells
  Claude to prefer it when a symbol hit looks off.

> Net: for navigation (definition + representative usages) the plugin is more accurate **and** far
> cheaper; for an exhaustive occurrence audit, raise the cap or use grep on purpose.

### Incomplete results (correctness guard)
Capping is good for tokens but dangerous for "find ALL references" — a missed call site means wrong
code. So truncation is **never silent**:

1. When the first fetch looks truncated, the proxy **auto-retries once** with a larger limit
   (`RIDER_ESCALATE_LIMIT`) to learn the true count.
2. If the set is still not exhaustive, the response carries a loud `⚠ INCOMPLETE RESULTS — showing X
   of Y+` banner with three options: **raise the cap**, **narrow scope (`paths`)**, or **confirm a
   partial set is acceptable**.
3. The skill instructs Claude: for references/refactor/rename, **stop and ask the user** with those
   options instead of acting on the partial list.

## How much did it save? (token-savings command)

The proxy records, per summarized call, the tokens it saved vs forwarding Rider's raw response. Check
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

## Prerequisites

- **JetBrains Rider 2025.2+**, running, with the project open.
- **Node.js ≥ 18** on PATH.
- Rider MCP enabled: **Settings | Tools | MCP Server → Enable MCP Server**, then **Copy SSE Config**.

## Install

```bash
# 1) Add the marketplace and install (also auto-installs ue-log-analyzer)
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer
/reload-plugins        # first run auto-installs the server deps (no manual npm)

# 2) Configure it — from inside Claude Code, just run:
/rider-mcp-enforcer:setup
#   It detects Rider's SSE endpoint, asks for the project path, and writes the config.
```

Verify the `rider-search` MCP server and its tools appear, and that a `grep src/**/*.cpp` is blocked
with a redirect message. (The `npm install` for each plugin's MCP server runs automatically on
session start via a hook into `${CLAUDE_PLUGIN_DATA}`.)

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
> you want clients to pick up changes. Config keys/commands/tools and the **Changelog** below must be
> updated in the same commit as any source change.

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
| `RIDER_ENFORCE` | `1` | Set to `0`/`false`/`off` to **disable the grep-blocking hook** — use this if Rider MCP is off/unavailable and you don't want code searches blocked. |

## How enforcement works

- The **hook** runs before every Bash call. If the command is a code-symbol search (grep/rg/ack/ag/
  findstr or `find -name` targeting `*.cpp/.h/.cs/...` or `src|source|engine|plugins/`) and is *not*
  aimed at a log/md/json/build path, it exits non-zero and Claude sees a message telling it to use
  the Rider tool. Otherwise it allows the command.
- The **skill** biases Claude toward the Rider tools proactively.
- The **proxy** guarantees the token cap regardless of how Claude calls the tool.

## Enable Rider MCP (do this first — it is OFF until you enable it)

The Rider MCP server is **not active by default in every build/setup** — many users have it disabled
and see the plugin "do nothing useful." Enable and locate it:

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
| **Code searches get blocked but Rider tools don't work** (MCP off → stuck) | Hook blocks grep while Rider is unavailable | Set `RIDER_ENFORCE=0` to disable the block until MCP is on, **or** disable the plugin. |
| Hook blocks a search you wanted | False positive on a code path | Target a non-code file, or set `RIDER_ENFORCE=0` for that session. |
| Wrong/empty summaries | Rider tool name differs from defaults, or unusual response shape | Set `RIDER_SUMMARIZE_TOOLS` to your build's tool names; tune `RIDER_MAX_RESULTS`. |
| `curl` to the SSE URL refuses connection | Rider not running, MCP off, or wrong port | Start Rider, enable MCP, re-copy the SSE config. |

> **The disabled-MCP footgun:** with MCP off, the proxy returns "not connected" *and* the hook would
> block code-grep — leaving Claude no way to search. The hook honors `RIDER_ENFORCE=0` precisely for
> this case: it disables blocking so grep works as a fallback until you turn MCP on.

## Status / caveats

- **v0.1.x, pre-live-verification of the Rider tool schema.** Tool names target Rider 2025.2+. If your
  build names a tool differently, check the `rider-search` tool list and set `RIDER_SUMMARIZE_TOOLS`.
- The summarizer is heuristic (keeps `path:line`-looking lines). Tune `RIDER_MAX_RESULTS` per repo.
- Transport is SSE. If your Rider build only offers stdio, open an issue — a stdio client mode can be
  added.

## Changelog

- **0.1.10** — self-learning tool map: what gets summarized is now decided by **response shape**
  (Rider's list JSON), not a hardcoded tool-name list. Auto-adapts to Rider version/tool renames,
  never trims non-list tools like `read_file`, and auto-escalation only fires on tools whose schema
  has a `limit`. `RIDER_SUMMARIZE_TOOLS` becomes an optional restrict filter.
- **0.1.9** — one-step install: declares `ue-log-analyzer` as a dependency (one `/plugin install` gets
  both), and the proxy's `npm install` runs automatically on session start (`${CLAUDE_PLUGIN_DATA}` +
  dynamic SDK resolution) — no manual `npm install`.
- **0.1.8** — hook fix: only block when a search tool is the **actual command** of a segment (no more
  false positives on `node setup.mjs`, `cd`, or paths/args containing `plugins`/`source`/`rg`);
  Korean README ([README.ko.md](README.ko.md)).
- **0.1.7** — in-Claude setup + savings as typed slash commands (`commands/`); config file
  `~/.rider-mcp-enforcer/config.json` (env > config > default); `rider_setup`/`rider_config`/
  `rider_detect` tools; `setup.mjs`.
- **0.1.6** — default build-artifact exclude filter; cumulative token-savings ledger + `rider_savings`
  tool / `/savings` / `stats.mjs`.
- **0.1.5** — never-silent truncation: auto-escalate once, then loud `INCOMPLETE` banner; per-line cap.
- **0.1.4** — measured token/time benchmark + accuracy analysis (BENCHMARK.md).
- **0.1.3** — documented that Rider MCP only searches projects open in the IDE.
- **0.1.2** — aligned to the real Rider MCP tool schema (live-verified).
- **0.1.1** — handle disabled/unreachable Rider MCP (`RIDER_ENFORCE=0` escape).
- **0.1.0** — initial: JetBrains-MCP reuse + grep-blocking hook + routing skill + summarizing proxy.

## Contributing

Issues and PRs welcome — bug reports, new log formats/engines, additional Rider tool mappings, or docs.

This repo is maintained with **AI-assisted review**, so PRs are judged from the diff + description +
evidence: keep them **small, clearly described, evidenced, and free of any proprietary data**. Please
read **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening a PR.

**⭐ If this saved you tokens or debugging time, a star helps others find it.**

## Privacy

These plugins collect no personal data and process everything locally — see [PRIVACY.md](PRIVACY.md).

## License

MIT © 2026 JSungMin
