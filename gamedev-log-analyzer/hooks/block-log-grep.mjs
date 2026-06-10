#!/usr/bin/env node
/*
 * gamedev-log-analyzer — PreToolUse hook (matcher: Bash).
 *
 * Intercepts raw log text-dumps (grep/rg/tail/cat/… over a `.log` / `.jsonl` / Logs dir) and steers
 * them to `gamedev-log`, which parses + dedups + token-caps instead of flooding raw lines into
 * context. Mirrors rider-mcp-enforcer's code-grep block, but for the LOG domain (which that hook
 * deliberately lets through).
 *
 * Modes (env GDLOG_ENFORCE > ~/.gamedev-log-analyzer/config.json "enforce" > "block"):
 *   block (default) -> exit 2, command denied, nudge shown to the model
 *   warn            -> exit 0, command allowed, nudge shown (soft)
 *   off             -> exit 0, silent passthrough
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block (stderr is shown to the model).
 * Fail-open: any parse/IO error allows the command (never wedge the user's shell).
 */
import { shouldBlockLogBash, enforceMode, nudgeText } from "../server/enforce.js";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = ((JSON.parse(input).tool_input) || {}).command || "";
  } catch {
    process.exit(0); // unparseable — don't block
  }
  if (!cmd) process.exit(0);

  let mode = "block";
  try {
    mode = enforceMode();
  } catch {
    process.exit(0); // config trouble — fail open
  }
  if (mode === "off") process.exit(0);

  let hit = false;
  try {
    hit = shouldBlockLogBash(cmd);
  } catch {
    process.exit(0);
  }
  if (!hit) process.exit(0);

  process.stderr.write(nudgeText(cmd) + "\n");
  process.exit(mode === "warn" ? 0 : 2); // warn = allow+nudge; block = deny+nudge
});
