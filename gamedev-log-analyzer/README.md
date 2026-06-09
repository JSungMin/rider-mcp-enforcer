# gamedev-log-analyzer

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

- **Parses** each line into `{severity, category, file:line, message}` across several engines (see the
  support matrix below), with a generic severity-keyword fallback for anything unrecognized.
- **Template dedup:** numbers/addresses/GUIDs/paths/instance-ids are normalized so repeated spam
  collapses into one group with a `×count` and representative locations.
- **Search/filter:** by `severityMin`, `category`, `file`, `query`; `groupBy: "callsite"` rolls
  everything up by `file:line` (best for "what's flooding my log").
- **`log_fields`:** generic columnar extractor for dense per-frame trace logs — pulls only the chosen
  scalars (`Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`).
- **`log_diff`:** compare two logs (before/after) and emit **only the delta** — new errors, errors that
  disappeared, and groups whose count changed. Unchanged groups are omitted, so a regression-triage diff
  across runs costs a fraction of re-reading either log.

## Supported log formats

| Source | Example line | Category | Verification |
| --- | --- | --- | --- |
| **Unreal runtime** | `[..][f]LogTemp: Error: msg` | the `Log*` category | ✅ live-verified (18–57 MB real logs) |
| **MSVC / UBT / MSBuild compile** | `Foo.cpp(120): error C2065: msg` | `Build` | ✅ live-verified |
| **MSVC / UBT linker** | `Foo.obj : error LNK2019: msg` | `Build` | ✅ live-verified |
| **Unity C# compile** | `Assets/X.cs(12,34): error CS1002: msg` | `Build` | ✅ verified (shares the compile path) |
| **Unity runtime / stack** | `NullReferenceException …`, `(at Assets/X.cs:42)` | generic + location | ⚠️ best-effort — **not** verified against real Unity logs |
| **Godot** | `SCRIPT ERROR: …`, `at: f (res://x.gd:42)` | `Godot` | ⚠️ best-effort — **not** verified against real Godot logs |
| **Anything else** | severity keyword (`error`/`warning`/`exception`/…) | generic + location | partial fallback |

> ⚠️ **Unity-deep and Godot parsing are best-effort from each engine's public docs/console output — they
> have NOT been verified against real Unity/Godot project logs yet.** Unrecognized lines still get the
> generic fallback, and the local **learnings ledger** (`gamedev-log learnings`) reports templated shapes of
> unparsed lines so real-world gaps surface as concrete parser candidates. Real Unity/Godot log samples
> (sanitized) are very welcome — please open an issue.

## How Claude uses it (CLI by default)
Claude reaches the analyzer through a **skill** that shells out to the `gamedev-log` CLI — there is **no
always-on context cost** (nothing sits in the prompt until a log is actually relevant). Just ask
"check the editor logs" / "what's flooding the log" / "what changed since the last run", or run the
`/gamedev-log-analyzer:logs` command. Under the hood it runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

**Commands** (`gamedev-log <command>`): `detect`, `summary`, `search`, `fields`, `diff`, `locate`, `tail`,
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
#    { "mcpServers": { "gamedev-log": { "command": "node",
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
/plugin install gamedev-log-analyzer@rider-mcp-enforcer
/reload-plugins
/gamedev-log-analyzer:logs                        # or: ask "check the editor logs"
```
No build, no `npm install` — the CLI is pure Node. (Installing `rider-mcp-enforcer` also pulls this in
automatically — see the [marketplace](../README.md#marketplace--two-plugins).) To use typed MCP tools
instead, see [Optional: enable the MCP server](#optional-enable-the-mcp-server).

## Setup
Settings live in `~/.gamedev-log-analyzer/config.json` (precedence: env > config > default). Configure via
`gamedev-log setup …` (e.g. `node server/cli.js setup --projectPath "<dir>"`) or env vars:

| env | config key | default | meaning |
| --- | --- | --- | --- |
| `GDLOG_PROJECT_PATH` | `projectPath` | — | Project root; UE logs auto-found under `<root>/Saved/Logs` (incl. one subdir level for the `.uproject` dir). |
| `GDLOG_PATH` | `logPath` | — | Explicit default log file. |
| `GDLOG_MAX_BYTES` | `logMaxBytes` | `5000000` | Huge logs: read only the last N bytes. |
| `GDLOG_MAX_GROUPS` | `maxGroups` | `40` | Max deduped groups per `log_search`. |
| `GDLOG_MAX_LINE_CHARS` | `maxLineChars` | `200` | Max chars per shown snippet. |

## Pairs with rider-mcp-enforcer
Log entries carry `file:line`. If [rider-mcp-enforcer](../README.md) is also installed, feed those
locations to its `get_symbol_info` / `read_file` to jump straight to the source. See
[Using both together](../README.md#using-both-together).

## Version history
See the **[Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)** page — every `v*` tag
publishes categorized, PR-linked notes automatically. The release badge above always points at the latest.

## License
MIT © 2026 JSungMin
