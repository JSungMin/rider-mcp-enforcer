---
name: ue-log-analyzer
description: >-
  Analyze an editor or build log (Unreal Engine Saved/Logs, Unity Editor.log, MSVC/UBT/C# build
  output, or any structured text log) token-efficiently. Use when the user mentions checking,
  reading, searching, summarizing, or diffing a log; investigating editor/engine errors, warnings,
  crashes, asserts, callstacks, or log spam; or asks "what's flooding the log" / "what changed since
  the last run". Parses, deduplicates, classifies by severity/category, and extracts decisive fields
  via the `ue-log` CLI instead of dumping the raw file (logs can be tens of MB).
---

# ue-log-analyzer — editor/build log analysis (CLI)

Read logs through the **`ue-log` CLI**, never `cat`/`grep`/`Get-Content` the raw file — editor logs
are routinely tens of MB and will flood the context. The CLI parses → classifies → deduplicates →
returns a compact, token-capped summary (often ~99% smaller than the raw log).

## How to run it

Invoke via **Bash** using the plugin-root absolute path (no PATH/setup needed; pure Node, no deps):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

Quote every path argument (Windows paths/spaces). `--help` lists everything.

## Commands

- `detect` — find editor logs (newest first). `--projectPath <dir>` (UE: scans `<dir>/Saved/Logs`,
  one subdir deep; Unity: `Editor.log`). Run this first if you don't have a path.
- `summary` — severity counts + top categories, no message bodies. `--path | --projectPath`.
- `search` — parse + dedup into templated groups with `×count` + locations, severity-sorted, capped.
  - `--severityMin Error|Warning|Display` (default Warning) · `--query <substr>` · `--category <Cat>`
  - `--file <pathfrag>` · `--groupBy template|callsite` (callsite = roll up by `file:line`, best for
    "which callsite floods the log") · `--maxGroups N`
- `diff` — compare two logs, emit ONLY the delta (new / gone / count-changed groups; unchanged
  omitted). `--pathA <before> --pathB <after>`, or omit both to auto-pick the two newest detected
  logs. Same filters as `search` plus `--minDelta N`. Token-cheap "what changed since last run?".
- `locate` — jump list: just the distinct `file:line` of matched entries (no message bodies), ranked
  by severity then count. `--severityMin Error` (default) · `--basename` (strip to filename, for
  Rider's name search) · `--query --category --file --max`. The compact handoff for opening source.
- `fields` — pull just decisive scalars from dense per-frame trace logs into a compact table.
  `--fields Pawn,Alpha,ts,Pos.x,step:Pos,d:Yaw` (forms: `Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`,
  `dts`, `d:Key`, `step:Key`) · `--query` · `--window t0,t1` · `--max N`. Biggest win on per-frame logs.
- `tail` — last N raw lines (escape hatch). `--lines N`.
- `setup` / `config` — persist/show settings (`~/.ue-log-analyzer/config.json`). Keys: `--projectPath
  --logPath --logMaxBytes --maxGroups --maxLineChars`.
- `learnings` / `learnings-reset` — local sanitized parse-coverage report.

## Default flow ("check the logs")

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" detect  --projectPath "<project>"
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" summary --path "<log>"
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" search  --path "<log>" --severityMin Error
```

Then report the errors with their `file:line` locations. For per-frame/trace noise use `fields`; for
regression triage across two runs use `diff`.

## Jump from a log error to the source (with rider-mcp-enforcer)

Log entries carry `file:line`. When the user wants to **open / fix the offending code** and
`rider-mcp-enforcer` is installed, use this token-frugal loop instead of reading whole files:

1. **Get the jump list** — distinct locations only, no bodies:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" locate --path "<log>" --severityMin Error --basename
   ```
   `--basename` strips paths to `Foo.cpp:123` so Rider's filename search can resolve them.
2. **Resolve each filename → full path** via Rider: `find_files_by_name_keyword` (or `search_file`)
   with the basename. Logs often carry partial/relative paths; Rider's index has the real one.
3. **Read just the relevant window** at that line via Rider `read_file` (a small line range around the
   number), or `get_symbol_info` for the enclosing symbol — never dump the whole file.

Skip `locate` and read directly only when there's a single known location. For many errors, `locate`
first so you batch-resolve the distinct callsites instead of re-scanning the log per file.

## Why CLI (not an MCP server) by default

The CLI carries **no always-on context cost** — nothing sits in the prompt until you run it — whereas
an MCP server injects its tool schemas into every session. The ~99% output reduction is identical
either way. Users who prefer typed MCP tools can opt in (see the README), but the CLI is the default.
