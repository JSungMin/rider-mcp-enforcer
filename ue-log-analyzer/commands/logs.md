---
description: Analyze the editor log (Unreal Saved/Logs, Unity Editor.log, or any structured log) — parse, deduplicate, classify by severity/category, and read it token-efficiently instead of dumping the raw file.
---

# ue-log-analyzer — editor log analysis

Read the editor log smartly via the `ue-log` MCP tools — never `cat`/`grep` the raw log (they can be
tens of MB).

Steps:
1. **Locate it:** call `log_detect` (uses the configured `projectPath`; finds UE `Saved/Logs/*.log` and
   Unity `Editor.log`, newest first). If nothing is found, ask the user for the log path, or run
   `log_setup` to set `projectPath`/`logPath`.
2. **Triage:** call `log_summary` for severity counts + top categories.
3. **Search/filter:** call `log_search`. Useful args:
   - `severityMin` — `Error` for errors only, `Warning` (default) for both.
   - `query` — substring on message/category.
   - `category` — exact log category (e.g. `LogStreaming`).
   - `file` — only entries whose `file:line` location contains this.
   - `groupBy` — `template` (per distinct message, default) or `callsite` (roll up by `file:line` — best
     for "which callsite is flooding the log").
4. **Decisive scalars (dense trace logs):** call `log_fields` to pull just the fields that decide the
   answer into a compact table — `fields: ["ts","Alpha","Pos.x","step:Pos","d:Yaw"]`. Forms: `Key`,
   `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key` (deltas vs previous row). This is the
   biggest token saver on per-frame logs.
5. **Jump to code (if rider-mcp-enforcer is also installed):** entries carry `file:line` — feed those to
   that plugin's `get_symbol_info` / `read_file` to open the source.
6. **Escape hatch:** `log_tail { lines: N }` for raw last N lines.

Default when the user just says "check the logs": `log_detect` → `log_summary` →
`log_search { severityMin: "Error" }`, then report the errors with their locations.

$ARGUMENTS
