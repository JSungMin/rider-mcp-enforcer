# ue-log-analyzer

**English** · [한국어](README.ko.md) · part of the [rider-mcp-enforcer marketplace](../README.md#marketplace--two-plugins)

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

## Commands & tools
- `/ue-log-analyzer:logs` — guided: detect → summary → errors with locations.
- MCP tools (server `ue-log`): `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_tail`,
  `log_setup`, `log_config`.

## Prerequisites
- **Node.js ≥ 18** on PATH. (No Rider/Unity install needed — it only reads the log file.)

## Install
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install ue-log-analyzer@rider-mcp-enforcer
cd <plugin-dir>/server && npm install      # one time
/ue-log-analyzer:logs                        # or: ask "check the editor logs"
```

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
- **0.1.0** — initial: `log_detect`/`log_search`/`log_summary`/`log_fields`/`log_tail` +
  `/ue-log-analyzer:logs`. UE/Unity/generic parsing, template dedup, callsite rollup, field extraction.

## License
MIT © 2026 JSungMin
