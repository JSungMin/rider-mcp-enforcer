---
description: Analyze the game-engine/build log (Unreal Saved/Logs, Unity Editor.log, Godot output, MSVC/UBT/MSBuild, or any structured log) — parse, deduplicate, classify by severity/category, and read it token-efficiently via the gamedev-log CLI instead of dumping the raw file.
---

# gamedev-log-analyzer — game-engine/build log analysis

Read the log smartly via the **`gamedev-log` CLI** — never `cat`/`grep`/`Get-Content` the raw log
(it can be tens of MB). Run it through **Bash** with the plugin-root path (pure Node, no deps, no PATH
setup); quote every path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

Steps:
1. **Locate it:** `… detect --projectPath "<dir>"` (UE `Saved/Logs/*.log` + Unity `Editor.log`, newest
   first). If nothing is found, ask for the log path or persist one with `… setup --projectPath/--logPath`.
2. **Triage:** `… summary --path "<log>"` for severity counts + top categories.
3. **Search/filter:** `… search --path "<log>"`. Useful flags:
   - `--severityMin Error` (errors only) | `Warning` (default).
   - `--query <substr>` · `--category <Cat>` (e.g. `LogStreaming`) · `--file <pathfrag>`.
   - `--groupBy callsite` rolls up by `file:line` (best for "which callsite floods the log").
   - `--groupBy code` rolls up by diagnostic code (`C4996`/`LNK2019`/`CS1002` …) — collapses a noisy
     build to one line per code (`C4996: … (×37)`); the token-cheap way to triage a build vs grepping it.
4. **Decisive scalars (dense trace logs):** `… fields --path "<log>" --fields ts,Alpha,Pos.x,step:Pos,d:Yaw`.
   Forms: `Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`. Biggest token saver on
   per-frame logs.
5. **Regression triage across runs:** `… diff --pathA "<before>" --pathB "<after>"` — only the delta
   (new / gone / count-changed); omit paths to auto-pick the two newest logs.
6. **Jump to code (if rider-mcp-enforcer is installed):** `… locate --path "<log>" --severityMin Error
   --basename` gives just the distinct `file:line` (no bodies). Resolve each filename via Rider
   `find_files_by_name_keyword`, then `read_file` a small window at that line — never dump whole files.
7. **Escape hatch:** `… tail --lines N` for raw last N lines.

Default when the user just says "check the logs": `detect` → `summary` → `search --severityMin Error`,
then report the errors with their locations. (`… --help` lists every command.)

Prefer the CLI: it has **zero always-on context cost**. Users who enabled the optional MCP server can
use the equivalent `log_*` tools instead — identical output.

$ARGUMENTS
