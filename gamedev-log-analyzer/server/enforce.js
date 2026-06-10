/*
 * gamedev-log-analyzer — log-grep enforcement engine (pure, testable).
 *
 * Decides whether a Bash command is a raw text-dump of a LOG file (grep/tail/cat/… over a `.log` /
 * `.jsonl` / Logs dir) that should instead go through `gamedev-log` (parse + dedup + token-cap).
 * The PreToolUse hook (hooks/block-log-grep.mjs) imports this; the eval imports it too. Keeping the
 * logic here (not inline in the hook) is what makes it unit-testable.
 *
 * Mode is read the same way core.js reads config: env GDLOG_ENFORCE > ~/.gamedev-log-analyzer/config.json
 * "enforce" > default "block". Modes: "block" (deny + nudge), "warn" (allow + nudge), "off" (allow).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Text-dump executables that flood raw log lines into context. `node`/`gamedev-log` are NOT here, so
// the analyzer's own invocations never trip the hook.
export const READ_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr", "tail", "head", "cat"]);

export function execOf(segment) {
  const tokens = String(segment).trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // skip FOO=bar prefixes
  let exec = (tokens[i] || "").toLowerCase();
  exec = exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, ""); // basename, drop win ext
  return exec;
}

// A log target = a `.log` / `.jsonl` / rotated `.log.N` file, or a path under a Logs/Saved/Logs dir.
// `.json` is intentionally excluded (configs); only line-delimited `.jsonl` counts as a log.
function hasLogTarget(s) {
  return (
    /\.(log|jsonl)\b/.test(s) ||
    /\.log\.\d+\b/.test(s) ||
    /(^|[\s"'/\\])(saved[\\/]logs|logs)[\\/]/.test(s)
  );
}

export function isLogReadSegment(segment) {
  const exec = execOf(segment);
  if (!READ_EXECS.has(exec)) return false;
  return hasLogTarget(String(segment).toLowerCase());
}

// True if ANY shell segment of the command is a raw log read (so `tail x.log | grep err` is caught
// even though the grep half has no filename — the tail half does).
export function shouldBlockLogBash(cmd) {
  const segments = String(cmd || "").split(/\|\||&&|[|;&\n]/g);
  return segments.some((seg) => seg.trim() && isLogReadSegment(seg));
}

// ---- mode (env > config.json > default) ----
const CONFIG_FILE =
  process.env.GDLOG_CONFIG_FILE || path.join(os.homedir(), ".gamedev-log-analyzer", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

const VALID_MODES = ["block", "warn", "off"];

// Normalize loose aliases so `on/1/true` → block, `0/false/none` → off.
export function normalizeMode(v) {
  const m = String(v || "").toLowerCase().trim();
  if (["off", "0", "false", "none", "allow"].includes(m)) return "off";
  if (["warn", "nudge", "soft"].includes(m)) return "warn";
  if (["block", "on", "1", "true", "deny", "hard"].includes(m)) return "block";
  return null;
}

export function enforceMode() {
  const env = process.env.GDLOG_ENFORCE;
  if (env !== undefined && env !== "") return normalizeMode(env) || "block";
  const fromCfg = readConfig().enforce;
  if (fromCfg !== undefined && fromCfg !== null && fromCfg !== "") return normalizeMode(fromCfg) || "block";
  return "block"; // default: actually enforce
}

export function enforceSource() {
  if (process.env.GDLOG_ENFORCE !== undefined && process.env.GDLOG_ENFORCE !== "") return "env GDLOG_ENFORCE";
  if (readConfig().enforce != null && readConfig().enforce !== "") return CONFIG_FILE;
  return "default";
}

// Persist mode into config.json (merge-preserving other keys). Returns the written mode.
export function writeEnforceMode(mode) {
  const norm = normalizeMode(mode);
  if (!norm) throw new Error(`mode must be one of: ${VALID_MODES.join(" | ")} (or on/off aliases)`);
  const cur = readConfig();
  cur.enforce = norm;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2));
  return norm;
}

// The nudge shown when a raw log read is intercepted. One source of truth for hook + tests.
export function nudgeText(cmd) {
  return (
    "[gamedev-log-analyzer] Intercepted a raw log read via Bash" +
    (cmd ? `:\n  ${String(cmd).slice(0, 200)}` : "") +
    "\nUse gamedev-log instead — it parses, dedups, and token-caps the log " +
    "(a multi-MB log → a few hundred tokens) rather than dumping raw lines into context:\n" +
    "  - severity + category rollup   -> gamedev-log summary --path <log>\n" +
    "  - search / dedup groups        -> gamedev-log search  --path <log> --severityMin Warning\n" +
    "  - build warnings by code       -> gamedev-log search  --path <log> --groupBy code\n" +
    "  - jump list (file:line only)   -> gamedev-log locate  --path <log>\n" +
    "  - scalar fields over time      -> gamedev-log fields  --path <log> --fields ts,<Key>\n" +
    "Genuinely need the raw bytes? Lower enforcement: `gamedev-log enforce warn` (nudge only) or " +
    "`gamedev-log enforce off` (allow), or set GDLOG_ENFORCE=off for this shell."
  );
}
