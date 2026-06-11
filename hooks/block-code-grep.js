#!/usr/bin/env node
/*
 * rider-mcp-enforcer — PreToolUse hook (matchers: Bash, Grep)
 *
 * Steers code-symbol search toward Rider's MCP index instead of text search. Two vectors:
 *   - Bash: grep/rg/ack/ag/findstr (or `find -name`) over C/C++/C# source. warn (default) nudges and
 *     lets it run; RIDER_ENFORCE=block denies (exit 2). Raw non-code text (logs, md, json) passes.
 *   - Grep TOOL: the model's reflexive code search lives in the built-in Grep tool, not Bash — so the
 *     Bash-only hook never fired where the habit is. The Grep branch nudges too, but is **warn-ONLY,
 *     never block**: Grep is the sanctioned fallback (and the right call on a just-edited/unindexed file
 *     Rider hasn't reindexed), so blocking it would strand the model. RIDER_ENFORCE=block does NOT
 *     escalate the Grep branch; =0/off silences it.
 *
 * The Bash branch only triggers when a search tool is the ACTUAL executable of a command segment — so
 * `node setup.mjs ...`, `cd ".../plugins/..."`, etc. are never blocked just because a path or argument
 * happens to contain "rg", "plugins", "source", and the like.
 *
 * Kill-metric (the Grep nudge is an experiment, not a permanent feature): the nudge carries the
 * distinctive marker "via the Grep tool", so a session transcript can be measured for
 * nudge-fires vs. subsequent rider-search calls. If that conversion stays ~0, pull the Grep branch —
 * it's context pollution, not steering. Kept IO-free on purpose (no per-call counter file): token-first.
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block, stderr shown to the model.
 */

// Pure classifiers live in a side-effect-free module so the `discover` analyzer can share the EXACT
// same detection without importing this hook's stdin/exit behavior (single source of truth).
import { isCodeSearchSegment, isCodeGrepTool } from "./detectors.js";

function parseMode() {
  // env RIDER_ENFORCE > default "warn". Default NUDGES; opt into hard denial (Bash only) with
  // RIDER_ENFORCE=block; RIDER_ENFORCE=0/off disables the nudge too.
  const raw = String(process.env.RIDER_ENFORCE ?? "warn").toLowerCase();
  if (["0", "false", "off", "none", "allow"].includes(raw)) return "off";
  if (["1", "true", "on", "block", "deny", "hard"].includes(raw)) return "block";
  return "warn";
}

function emitWarn(text) {
  // allow, but inject the nudge into the model's context (stderr on exit 0 isn't reliably surfaced).
  // Trailing newline for line-buffered stdout readers.
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }) + "\n"
  );
}

// Honest nudge (~50 tok). Does NOT claim Rider is "semantically complete" — this Rider build has no
// semantic find-references; references are an indexed string match (same blind spots as grep). The real
// edge is the token-cap + INCOMPLETE banner discipline, and search_symbol being semantic for DEFINITIONS.
const GREP_NUDGE =
  "[rider-mcp-enforcer] Code search via the Grep tool on C#/UE-C++. " +
  "For find-references / dead-code on ESTABLISHED code, prefer rider-search (server: 'rider-search') — " +
  "it's token-capped and flags INCOMPLETE result sets so you don't act on a partial list; `search_symbol` " +
  "is semantic for definitions. For a JUST-edited / unindexed file (Rider's index lags fresh saves) or a " +
  "quick literal peek, Grep is the right call — carry on. Disable: RIDER_ENFORCE=0.";

function bashNudge(mode) {
  return (
    "[rider-mcp-enforcer] " + (mode === "block" ? "Blocked" : "Heads-up:") + " a code-symbol search via Bash.\n" +
    "Prefer the Rider MCP tools (server: 'rider-search') — token-capped, semantic (Rider's index):\n" +
    "  - symbol / definition         -> search_symbol  (args: q, limit, projectPath)\n" +
    "  - text / references in code   -> search_text or search_regex  (q, paths, limit)\n" +
    "  - file by name                -> search_file / find_files_by_name_keyword\n" +
    "  - type info at a position     -> get_symbol_info  (filePath, line, column)\n" +
    "Or delegate to the `code-locator` subagent (returns a compact file:line table). If multiple\n" +
    "projects are open, pass projectPath. Raw non-code text → re-run on a non-code file; disable with RIDER_ENFORCE=0."
  );
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let j;
  try {
    j = JSON.parse(input);
  } catch {
    process.exit(0); // unparseable — don't block
  }
  const toolName = j.tool_name || "";
  const ti = j.tool_input || {};

  const mode = parseMode();
  if (mode === "off") process.exit(0);

  // Grep TOOL — warn-only, never block (Grep is the fallback; denying it would strand the model).
  if (toolName === "Grep") {
    if (isCodeGrepTool(ti)) emitWarn(GREP_NUDGE);
    process.exit(0);
  }

  // Bash — code-grep classifier; honors block mode.
  const cmd = ti.command || "";
  if (!cmd) process.exit(0);

  // Evaluate each shell segment independently; only an actual search-tool invocation counts.
  const segments = cmd.split(/\|\||&&|[|;&\n]/g);
  const blocked = segments.some((seg) => seg.trim() && isCodeSearchSegment(seg));
  if (!blocked) process.exit(0);

  const nudge = bashNudge(mode);
  if (mode === "warn") {
    emitWarn(nudge);
    process.exit(0);
  }
  process.stderr.write(nudge + "\n");
  process.exit(2); // block (opt-in via RIDER_ENFORCE=block)
});
