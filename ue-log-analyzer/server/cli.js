#!/usr/bin/env node
/*
 * ue-log — CLI front-end for ue-log-analyzer (no MCP, no IDE).
 * Same engine as the MCP server: both call runTool() in core.js, so output is identical.
 * Zero always-on context cost (invoked via the shell), and portable to any agent/script/CI.
 *
 * Usage:  ue-log <command> [--flag value | --flag=value | --bare]
 * Commands: detect search summary fields diff tail learnings learnings-reset setup config
 * Examples:
 *   ue-log detect --projectPath /path/to/UEProject
 *   ue-log search --path Editor.log --severityMin Error --groupBy callsite
 *   ue-log fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
 *   ue-log diff --pathA before.log --pathB after.log --severityMin Error
 */
import { runTool } from "./core.js";

const HELP = `ue-log — token-efficient editor-log analysis (Unreal/Unity/generic).

Usage: ue-log <command> [options]

Commands:
  detect            Find editor logs (newest first).               [--projectPath]
  summary           Severity counts + top categories (no bodies).  [--path|--projectPath]
  search            Parse + dedup into templated groups w/ counts.
                    [--path --query --severityMin --category --file --groupBy --maxGroups]
  fields            Columnar scalar extraction from trace logs.
                    [--path --fields a,b,c --query --severityMin --window t0,t1 --max]
  diff              Delta between two logs (new/gone/changed only).
                    [--pathA --pathB | --projectPath] [--query --severityMin --category --file --groupBy --minDelta]
  locate            Jump list: distinct file:line of matches, no bodies (for opening source).
                    [--path --severityMin --category --file --query --basename --max]
  tail              Last N raw lines.                               [--path --lines]
  learnings         Local learnings report (parse coverage etc.).
  learnings-reset   Clear the local learnings ledger.
  setup             Persist config.   [--projectPath --logPath --logMaxBytes --maxGroups --maxLineChars]
  config            Show effective settings.

Field forms (fields/diff): Key, Key.x|.y|.z, Key.Y|.P|.R, ts, dts, d:Key, step:Key.
Settings precedence: env (UELOG_*) > ~/.ue-log-analyzer/config.json > default.`;

// Flags that should be parsed as comma-separated lists.
const LIST_FLAGS = new Set(["fields", "window"]);
// Flags with no value (presence = true).
const BOOL_FLAGS = new Set(["basename"]);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    if (!tok.startsWith("--")) continue;
    tok = tok.slice(2);
    let key, val;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      key = tok.slice(0, eq);
      val = tok.slice(eq + 1);
    } else {
      key = tok;
      if (BOOL_FLAGS.has(key)) {
        a[key] = true;
        continue;
      }
      val = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    }
    if (LIST_FLAGS.has(key)) {
      a[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
      if (key === "window") a.window = a.window.map(Number);
    } else {
      a[key] = val;
    }
  }
  return a;
}

// Accept "search" or "log_search" or "log-search"; allow a couple of natural aliases.
function normCommand(cmd) {
  if (!cmd) return "";
  let c = cmd.toLowerCase().replace(/-/g, "_");
  if (c === "learnings_reset") return "log_learnings_reset";
  c = c.replace(/^log_/, "");
  return "log_" + c;
}

const [, , rawCmd, ...rest] = process.argv;
if (!rawCmd || rawCmd === "-h" || rawCmd === "--help" || rawCmd === "help") {
  console.log(HELP);
  process.exit(rawCmd ? 0 : 1);
}
const name = normCommand(rawCmd);
const args = parseArgs(rest);
// convenience: a bare first positional after the command is treated as --path (or --severityMin for nothing else)
if (rest[0] && !rest[0].startsWith("--") && args.path === undefined && name !== "log_diff") {
  args.path = rest[0];
}

const { text, isError } = runTool(name, args);
(isError ? process.stderr : process.stdout).write(text + "\n");
process.exit(isError ? 1 : 0);
