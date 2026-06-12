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
import { isCodeSearchSegment, isCodeGrepTool, execOf } from "./detectors.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// First-use setup nudge: when the plugin was never configured, append a pointer to setup on whatever
// message we emit (the user is mid-grep — exactly when configuring helps). Same config file the proxy reads.
const CONFIG_FILE = process.env.RIDER_CONFIG_FILE || path.join(os.homedir(), ".rider-mcp-enforcer", "config.json");
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; } };
const notSetUp = () => { try { return !fs.existsSync(CONFIG_FILE); } catch { return false; } };
const SETUP_LINE =
  "\nNot set up yet? Run /rider-mcp-enforcer:setup (or `node <plugin>/proxy/setup.mjs --detect`) to set the Rider SSE URL + project root.";

// excludeCommands — finer than the global RIDER_ENFORCE=0 kill switch: a code search whose executable is
// in this list is left alone (no nudge, no block). Sources: config.json `excludeCommands` (array) +
// RIDER_EXCLUDE_COMMANDS (csv). Keyed by the bare executable name (grep/rg/ack/ag/findstr/find/git).
function excludedCommands() {
  const set = new Set();
  const cfg = readConfig();
  const list = Array.isArray(cfg.excludeCommands) ? cfg.excludeCommands : String(cfg.excludeCommands || "").split(",");
  for (const c of list.concat(String(process.env.RIDER_EXCLUDE_COMMANDS || "").split(","))) {
    const t = String(c).trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

// VCS output compaction (separate from code search): a read-only git/p4 command whose raw output is
// verbose + repetitive is rerouted to the compacting wrapper (`proxy/vcs.mjs` runs the real command, then
// groups/dedups/caps the output). NEVER blocks — the command still runs, unlike code-grep. On by default;
// RIDER_COMPACT_VCS=0 disables. This is the SAFE rewrite class: the target (git/p4) is a local CLI that
// always works (no IDE dependency), so a Bash→Bash rewrite can't strand the model. `git grep` is NOT here
// (it's a code search, handled above).
const VCS_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "proxy", "vcs.mjs");
const GIT_COMPACT_SUBS = new Set(["status", "log", "diff"]);
const P4_COMPACT_SUBS = new Set(["opened", "status", "changes", "reconcile"]);
const compactVcsOn = () => !/^(0|false|off|no)$/i.test(String(process.env.RIDER_COMPACT_VCS ?? "1"));

// Build a wrapper rewrite for a SINGLE read-only git/p4 command, or null. Conservative: bail on ANY shell
// metachar (quote/backtick/$/redirect/backslash) and on a global flag before the subcommand (`git -C path
// status` — the -C is ambiguous to split safely). The wrapper runs the command and compacts its output.
function buildVcsRewrite(segment) {
  if (/["'`$\\<>]/.test(segment)) return null; // any quoting/redirect → leave the original command alone
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar prefixes
  const exec = (toks[i] || "").replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/i, "").toLowerCase();
  if (exec !== "git" && exec !== "p4") return null;
  const sub = (toks[i + 1] || "").toLowerCase();
  if (!sub || sub.startsWith("-")) return null; // a global flag before the subcommand → too ambiguous
  const ok = exec === "git" ? GIT_COMPACT_SUBS.has(sub) : P4_COMPACT_SUBS.has(sub);
  if (!ok) return null;
  const rest = toks.slice(i + 1); // subcommand + its flags (passed verbatim as argv to the wrapper)
  if (!rest.every((t) => /^[A-Za-z0-9_.:=/-]+$/.test(t))) return null; // simple tokens only (no pathspec quoting)
  const argv = rest.map((t) => `"${t}"`).join(" ");
  return { bin: exec, sub, cmd: `node "${VCS_CLI}" ${exec} ${argv}` };
}

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

  const setup = notSetUp() ? SETUP_LINE : "";

  // Grep TOOL — warn-only, never block (Grep is the fallback; denying it would strand the model).
  if (toolName === "Grep") {
    if (isCodeGrepTool(ti)) emitWarn(GREP_NUDGE + setup);
    process.exit(0);
  }

  // Bash — code-grep classifier; honors block mode.
  const cmd = ti.command || "";
  if (!cmd) process.exit(0);

  // Evaluate each shell segment independently; only an actual search-tool invocation counts. A segment
  // whose executable is in excludeCommands is left alone (finer than the global RIDER_ENFORCE=0).
  const excluded = excludedCommands();
  const segments = cmd.split(/\|\||&&|[|;&\n]/g);
  const hit = segments.some((seg) => seg.trim() && isCodeSearchSegment(seg) && !excluded.has(execOf(seg)));

  if (hit) {
    const nudge = bashNudge(mode) + setup;
    if (mode === "warn") {
      emitWarn(nudge);
      process.exit(0);
    }
    process.stderr.write(nudge + "\n");
    process.exit(2); // block (opt-in via RIDER_ENFORCE=block)
  }

  // Not a code search → maybe a single read-only VCS command we can transparently compact (never blocks).
  const realSegs = segments.filter((s) => s.trim());
  if (compactVcsOn() && realSegs.length === 1 && !excluded.has(execOf(realSegs[0]))) {
    const v = buildVcsRewrite(realSegs[0]);
    if (v) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Rerouted ${v.bin} ${v.sub} → compacting wrapper (grouped/deduped/token-capped).`,
          updatedInput: { ...ti, command: v.cmd },
          additionalContext:
            `[rider-mcp-enforcer] Compacting \`${v.bin} ${v.sub}\` output (grouped/deduped/capped). ` +
            `The real command still runs. Disable: RIDER_COMPACT_VCS=0.`,
        },
      }) + "\n");
      process.exit(0);
    }
  }
  process.exit(0);
});
