---
description: Regenerate Unreal project files so Rider re-indexes new/moved/renamed source (fixes "doesn't exist"/empty searches from a stale project model). Dry-run-first; safe.
---

# Rider plugin — regenerate project files

Use when Rider can't find a source file that exists on disk (searches return "doesn't exist"/empty
after files were added/moved/renamed) — the generated project files are stale.

**Preferred (no MCP shell-approval prompt): run the CLI yourself.** Because *you* run it, there's no
"allow MCP shell access" warning:

1. Dry run — see what it would do, runs nothing:
   `node "${CLAUDE_PLUGIN_ROOT}/proxy/regen.mjs"`
   It prints the resolved `.uproject`, the engine (and how it was resolved), and the exact command.
2. Review that engine + command. If wrong, pin it (no code change needed):
   `node "${CLAUDE_PLUGIN_ROOT}/proxy/setup.mjs" regenCmd="<your generate command, {uproject}/{engine} tokens>"`
   or `... enginePath="<engine dir>"`.
3. Run it: `node "${CLAUDE_PLUGIN_ROOT}/proxy/regen.mjs" --confirm`  (add `--project="<root>"` if needed).

**Alternative: the `rider_regen_project` MCP tool.** Same engine, but it spawns a build, so Claude Code
will ask you to approve the tool (expected — it runs a shell command). It is **dry-run-first**: a call
without `confirm` only shows the plan; pass `confirm:true` to execute. `force:true` ignores a stale lock.

**After a successful regen, Rider must RELOAD the solution before its symbol index updates** — accept
Rider's reload prompt (it detects the `.vcxproj` change), or do it manually: **File → Reload All from
Disk** (or Unreal **Refresh**). Only then do `search_symbol` / `rename_refactoring` resolve the new
files. (A regen exiting 0 means the generator ran, not that Rider re-indexed. Rider exposes no reload
trigger, so this step is manual.)

To check whether the reload took: call the **MCP tool** with `verifyPath:"<the file that was missing>"`
and `confirm:true` — after the regen it re-probes Rider and reports **✓** (visible now) or **✗** (still
missing → reload + retry). Verification needs Rider connected, so it's only on the MCP tool, not the CLI.

Notes:
- Auto-detect is **Windows-only**; on macOS/Linux set `RIDER_REGEN_CMD` to your `GenerateProjectFiles.sh`
  invocation. Config precedence: env var > `~/.rider-mcp-enforcer/config.json` > default.
- Never write internal project paths or symbol names into any public/shared location.

$ARGUMENTS
