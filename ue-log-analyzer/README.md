# ue-log-analyzer

**English** · [한국어](README.ko.md) · part of the [rider-mcp-enforcer marketplace](../README.md#marketplace--two-plugins)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

A **Claude Code plugin** that reads huge editor logs **token-efficiently**. Unreal `Saved/Logs/*.log`
and Unity `Editor.log` are often tens of MB of repeated spam — `cat`/`grep` floods the context. This
plugin parses, **deduplicates**, and classifies them instead. **No IDE required** — pure file parsing.

## Why it's fast (measured)

Real numbers on a live Unreal log (no project source reproduced):

| Task | Raw | This plugin | Reduction |
| --- | ---: | ---: | ---: |
| Read a 57 MB UE log | ~1,250,000 tok | ~2,500 tok (deduped summary) | **~99.8%** |
| Search one trace tag (9,226 hits) | ~690,000 tok | ~1,700 tok (callsite rollup) | **~99.8% (~410×)** |
| Pull decisive scalars from a window | ~35,000 tok (raw dump) | ~160 tok (`log_fields`) | **~99.5%** |

The win: never put raw log lines in context — emit deduped groups, a callsite rollup, or just the
scalar columns that decide the answer.

## What it does

- **Parses** each line into `{severity, category, file:line, message}` — Unreal runtime
  (`[..]LogCat: Warning: msg`), build/compile errors (`path(line): error C####: msg`), Unity
  (`… (at Assets/X.cs:42)`), and a generic fallback (severity keyword + location).
- **Template dedup:** numbers/addresses/GUIDs/paths/instance-ids are normalized so repeated spam
  collapses into one group with a `×count` and representative locations.
- **Search/filter:** by `severityMin`, `category`, `file`, `query`; `groupBy: "callsite"` rolls
  everything up by `file:line` (best for "what's flooding my log").
- **`log_fields`:** generic columnar extractor for dense per-frame trace logs — pulls only the chosen
  scalars (`Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`).
- **`log_diff`:** compare two logs (before/after) and emit **only the delta** — new errors, errors that
  disappeared, and groups whose count changed. Unchanged groups are omitted, so a regression-triage diff
  across runs costs a fraction of re-reading either log.

## Commands & tools
- `/ue-log-analyzer:logs` — guided: detect → summary → errors with locations.
- MCP tools (server `ue-log`): `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_diff`,
  `log_tail`, `log_learnings`, `log_learnings_reset`, `log_setup`, `log_config`.
- CLI (`ue-log <command>`): the **same** commands as a shell binary — `detect`, `summary`, `search`,
  `fields`, `diff`, `tail`, `learnings`, `learnings-reset`, `setup`, `config`.

## Two ways to run: MCP or CLI
The analysis engine ([`server/logs.js`](server/logs.js) + [`server/core.js`](server/core.js)) is
transport-agnostic — both front-ends call one `runTool()`, so **output is byte-for-byte identical**.

| | MCP server (`index.js`) | CLI (`ue-log`, `cli.js`) |
| --- | --- | --- |
| How Claude calls it | `log_*` tools | `Bash: ue-log <cmd>` |
| Always-on context cost | tool schemas live in the prompt every session (~1–1.5k tok) | **none** — invoked via the shell |
| Structured args | yes (typed, no shell quoting) | flags (`--severityMin Error`) |
| Runs outside Claude Code | no | **yes** — scripts, CI, other agents |
| Needs the MCP SDK | yes | **no** (pure `logs.js`/`core.js`) |

The headline **~99% token reduction is output compression** (dedup/summarize/diff) and is the **same in
both** — the transport only changes the small always-on overhead. Use the **CLI** when you want zero
MCP-schema cost or portability; use the **MCP server** when you want typed tools auto-discovered inside
Claude Code. To run CLI-only, disable the `ue-log` MCP server and call `ue-log …` from Bash.

```bash
# CLI examples (identical output to the matching log_* tool)
ue-log detect --projectPath /path/to/UEProject
ue-log search --path Editor.log --severityMin Error --groupBy callsite
ue-log fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
ue-log diff   --pathA before.log --pathB after.log --severityMin Error
ue-log --help
```

## Prerequisites
- **Node.js ≥ 18** on PATH. (No Rider/Unity install needed — it only reads the log file.)

## Install
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install ue-log-analyzer@rider-mcp-enforcer
/reload-plugins                              # first run auto-installs deps (no manual npm)
/ue-log-analyzer:logs                        # or: ask "check the editor logs"
```
(Installing `rider-mcp-enforcer` also pulls this in automatically — see the
[marketplace](../README.md#marketplace--two-plugins).)

## Setup
Settings live in `~/.ue-log-analyzer/config.json` (precedence: env > config > default). Configure via
`/ue-log-analyzer:logs` (it can run `log_setup`) or the `log_setup` tool / env vars:

| env | config key | default | meaning |
| --- | --- | --- | --- |
| `UELOG_PROJECT_PATH` | `projectPath` | — | Project root; UE logs auto-found under `<root>/Saved/Logs` (incl. one subdir level for the `.uproject` dir). |
| `UELOG_PATH` | `logPath` | — | Explicit default log file. |
| `UELOG_MAX_BYTES` | `logMaxBytes` | `5000000` | Huge logs: read only the last N bytes. |
| `UELOG_MAX_GROUPS` | `maxGroups` | `40` | Max deduped groups per `log_search`. |
| `UELOG_MAX_LINE_CHARS` | `maxLineChars` | `200` | Max chars per shown snippet. |

## Pairs with rider-mcp-enforcer
Log entries carry `file:line`. If [rider-mcp-enforcer](../README.md) is also installed, feed those
locations to its `get_symbol_info` / `read_file` to jump straight to the source. See
[Using both together](../README.md#using-both-together).

## Changelog
- **0.1.4** — **CLI front-end** (`ue-log <command>`): same engine as the MCP server (shared `core.js`
  `runTool`), byte-identical output, but **zero always-on context cost** and portable outside Claude Code
  (scripts/CI/other agents). MCP server slimmed to a thin adapter. See *Two ways to run*.
- **0.1.3** — `log_diff`: compare two logs and emit only the delta (new / gone / count-changed groups),
  unchanged groups omitted — token-cheap regression triage across runs. Eval extended with diff metrics.
- **0.1.2** — local **learnings ledger** (`log_learnings` / `log_learnings_reset`): tracks parse coverage,
  top categories, and templated shapes of unparsed lines (candidates for new parsers) — sanitized,
  never transmitted. Self-contained eval harness (`eval/run.mjs`) + CI.
- **0.1.1** — auto-installs its server deps on session start (`${CLAUDE_PLUGIN_DATA}` + dynamic SDK
  resolution) — no manual `npm install`.
- **0.1.0** — initial: `log_detect`/`log_search`/`log_summary`/`log_fields`/`log_tail` +
  `/ue-log-analyzer:logs`. UE/Unity/generic parsing, template dedup, callsite rollup, field extraction.

## License
MIT © 2026 JSungMin
