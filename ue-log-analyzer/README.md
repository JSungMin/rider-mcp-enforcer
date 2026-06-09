# ue-log-analyzer

**English** · [한국어](README.ko.md) · part of the [rider-mcp-enforcer marketplace](../README.md#marketplace--two-plugins)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![CLI](https://img.shields.io/badge/CLI-zero%20deps-1f6feb)](#how-claude-uses-it-cli-by-default)
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

## How Claude uses it (CLI by default)
Claude reaches the analyzer through a **skill** that shells out to the `ue-log` CLI — there is **no
always-on context cost** (nothing sits in the prompt until a log is actually relevant). Just ask
"check the editor logs" / "what's flooding the log" / "what changed since the last run", or run the
`/ue-log-analyzer:logs` command. Under the hood it runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

**Commands** (`ue-log <command>`): `detect`, `summary`, `search`, `fields`, `diff`, `locate`, `tail`,
`learnings`, `learnings-reset`, `setup`, `config`.

```bash
# Run directly too — in scripts, CI, or any agent (pure Node, no dependencies):
node server/cli.js detect --projectPath /path/to/UEProject
node server/cli.js search --path Editor.log --severityMin Error --groupBy callsite
node server/cli.js fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
node server/cli.js diff   --pathA before.log --pathB after.log --severityMin Error
node server/cli.js locate --path Editor.log --severityMin Error --basename
node server/cli.js --help
```

**Jump from a log error to the source** — `locate` emits just the distinct `file:line` (no message
bodies). If [rider-mcp-enforcer](../README.md) is installed, resolve each basename via its
`find_files_by_name_keyword`, then `read_file` a small window at that line — never dump whole files.

## Optional: enable the MCP server
The same engine ([`server/logs.js`](server/logs.js) + [`server/core.js`](server/core.js)) also runs as
an MCP server (typed `log_*` tools, auto-discovered inside Claude Code). It is **off by default**
because a connected MCP server injects its tool schemas into **every** session (~1–1.5k tok always-on),
whereas the CLI costs nothing until used. The headline **~99% reduction is output compression and is
identical either way** — only the always-on overhead differs.

Turn it on if you prefer typed tools / structured args (no shell quoting):

```bash
# 1) install the MCP SDK once (the CLI needs no deps; the MCP server does)
cd server && npm install && cd ..
# 2) add .mcp.json at the plugin root, then /reload-plugins:
#    { "mcpServers": { "ue-log": { "command": "node",
#      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } } }
```

This exposes `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_diff`, `log_tail`,
`log_learnings`, `log_learnings_reset`, `log_setup`, `log_config` — byte-identical output to the CLI.

## Prerequisites
- **Node.js ≥ 18** on PATH. (No Rider/Unity install needed — it only reads the log file. The default
  CLI path has **zero npm dependencies**; only the optional MCP server needs `npm install`.)

## Install
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install ue-log-analyzer@rider-mcp-enforcer
/reload-plugins
/ue-log-analyzer:logs                        # or: ask "check the editor logs"
```
No build, no `npm install` — the CLI is pure Node. (Installing `rider-mcp-enforcer` also pulls this in
automatically — see the [marketplace](../README.md#marketplace--two-plugins).) To use typed MCP tools
instead, see [Optional: enable the MCP server](#optional-enable-the-mcp-server).

## Setup
Settings live in `~/.ue-log-analyzer/config.json` (precedence: env > config > default). Configure via
`ue-log setup …` (e.g. `node server/cli.js setup --projectPath "<dir>"`) or env vars:

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
- **0.2.1** — `log_locate` (CLI `locate`): jump list of distinct `file:line` for matched entries (no
  message bodies), ranked by severity then count; `--basename` strips paths for Rider's filename
  search. The compact handoff for opening offending source via rider-mcp-enforcer.
- **0.2.0** — **CLI-only by default** (token-first): the MCP server is now **off by default** (no
  `.mcp.json`, no SessionStart auto-`npm install`) — eliminates the always-on MCP schema tax (~1–1.5k
  tok/session). A new **skill** (`skills/logs/`) auto-discovers log work and drives the `ue-log` CLI via
  Bash. The default path has **zero npm dependencies**. MCP is now an opt-in (see *Optional: enable the
  MCP server*). Existing MCP users: add `.mcp.json` + `npm install` to keep typed tools.
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
