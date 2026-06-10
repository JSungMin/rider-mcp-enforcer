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

// A bare file path that is a log target (for the Read-tool branch, where there's no shell exec).
export function isLogPath(p) {
  return hasLogTarget(String(p || "").toLowerCase());
}

// Coarse volume gate for the Read tool: a log at/above this many bytes is worth steering to the
// analyzer (~3-5k tokens raw). Below it, a raw Read is cheap — let it through. Size is a blunt signal
// (it misses redundancy), but it's the only thing knowable WITHOUT reading the file. Hardcoded on
// purpose — no config key until there's evidence anyone needs to tune it.
export const READ_MIN_BYTES = 200_000;

// Decision for the `Read` tool. PURE — the caller supplies the file size and whether a slice
// (offset/limit) was requested, so this never touches the filesystem (the hook does the stat and
// fails open on any error). Intercept only an UNBOUNDED read of a LARGE LOG; a slice always passes,
// which is the one-step escape hatch (Read again with offset/limit) and Claude's fallback when the
// analyzer parses a format poorly.
export function shouldBlockRead(filePath, sizeBytes, sliced) {
  if (!filePath || sliced) return false;
  if (!isLogPath(filePath)) return false;
  return Number(sizeBytes) >= READ_MIN_BYTES;
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

// The nudge shown when a raw log read is intercepted. One source of truth for the hook + tests.
// `kind` ∈ {"bash","read"} controls the wording and the escape hatch so the message never lies about
// how the read happened. `target` is the command (bash) or the file path (read).
export function nudgeText(target, kind = "bash") {
  const t = String(target || "");
  const how = kind === "read" ? "a large log via the Read tool" : "a raw log read via Bash";
  const head = "[gamedev-log-analyzer] Intercepted " + how + (t ? `:\n  ${t.slice(0, 200)}` : "");
  const pathRef = kind === "read" && t ? t : "<log>";
  const tools =
    "\nUse gamedev-log instead — it parses, dedups, and token-caps the log " +
    "(a multi-MB log → a few hundred tokens) rather than dumping raw lines into context:\n" +
    `  - severity + category rollup   -> gamedev-log summary --path ${pathRef}\n` +
    `  - search / dedup groups        -> gamedev-log search  --path ${pathRef} --severityMin Warning\n` +
    `  - build warnings by code       -> gamedev-log search  --path ${pathRef} --groupBy code\n` +
    `  - jump list (file:line only)   -> gamedev-log locate  --path ${pathRef}\n` +
    `  - scalar fields over time      -> gamedev-log fields  --path ${pathRef} --fields ts,<Key>\n`;
  const escape =
    kind === "read"
      ? "Genuinely need the raw bytes? Re-run Read with `offset`/`limit` for a bounded slice (always " +
        `allowed), or peek with \`gamedev-log tail --path ${pathRef}\`, or lower enforcement: ` +
        "`gamedev-log enforce warn|off`."
      : "Genuinely need the raw bytes? Lower enforcement: `gamedev-log enforce warn` (nudge only) or " +
        "`gamedev-log enforce off` (allow), or set GDLOG_ENFORCE=off for this shell.";
  return head + tools + escape;
}
