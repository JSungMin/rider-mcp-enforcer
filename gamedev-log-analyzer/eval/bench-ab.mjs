// A/B benchmark for gamedev-log-analyzer: reading a log WITHOUT the plugin (Arm A: paste the raw
// file into the model's context) vs WITH it (Arm B: the gamedev-log CLI — summary / search / locate /
// diff). Reports only aggregate byte/token counts — never any log line — so it is safe to run against
// a private project's logs.
//
// Usage (from the repo root or anywhere):
//   LOG="/path/to/Editor.log" [LOG_B="/path/to/other.log"] node gamedev-log-analyzer/eval/bench-ab.mjs
//
// LOG_B (optional) enables the diff row (delta between two runs vs. pasting both raw logs).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "server", "cli.js");
const LOG = process.env.LOG;
const LOG_B = process.env.LOG_B || "";
if (!LOG || !fs.existsSync(LOG)) {
  console.error("Set LOG=/path/to/a/log/file (and optionally LOG_B=/path/to/second.log for the diff row).");
  process.exit(1);
}
const tok = (bytes) => Math.round(bytes / 4); // ≈ utf8 bytes ÷ 4
const fileTok = (p) => tok(fs.statSync(p).size);

// Run the CLI exactly as a user would and measure only the size of what it returns.
function cliTok(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) { console.error("[bench] cli failed:", r.error.message); return null; }
  return tok(Buffer.byteLength((r.stdout || "") + (r.stderr || ""), "utf8"));
}

const rawTok = fileTok(LOG);
const rows = [
  ["summary (severity counts + top categories)", cliTok(["summary", "--path", LOG]), rawTok],
  ["search Warning+ (dedup groups, callsite)", cliTok(["search", "--path", LOG, "--severityMin", "Warning", "--groupBy", "callsite", "--maxGroups", "50"]), rawTok],
  ["search Error+ (dedup groups, callsite)", cliTok(["search", "--path", LOG, "--severityMin", "Error", "--groupBy", "callsite", "--maxGroups", "50"]), rawTok],
  ["locate Error+ (file:line jump list)", cliTok(["locate", "--path", LOG, "--severityMin", "Error", "--max", "50"]), rawTok],
];
if (LOG_B && fs.existsSync(LOG_B)) {
  const concat = fileTok(LOG) + fileTok(LOG_B); // pasting both raw logs to compare runs
  rows.push(["diff Warning+ (delta of two runs)", cliTok(["diff", "--pathA", LOG, "--pathB", LOG_B, "--severityMin", "Warning"]), concat]);
}

const pct = (base, x) => (base > 0 && x != null ? `${(100 * (1 - x / base)).toFixed(2)}%` : "—");
console.log(`Log A/B — raw log ~${rawTok} tok${LOG_B ? ` (+ second log for diff)` : ""}`);
console.log(`(Arm A = paste the raw log; Arm B = gamedev-log CLI. token ≈ bytes ÷ 4; no log content shown)\n`);
console.log(`  ${"Operation".padEnd(44)} ${"B ~tok".padStart(8)}  ${"vs raw".padStart(8)}`);
for (const [label, t, base] of rows) {
  console.log(`  ${label.padEnd(44)} ${String(t ?? "ERR").padStart(8)}  ${pct(base, t).padStart(8)}`);
}
const ok = rows.filter((r) => r[1] != null);
if (ok.length) {
  const med = [...ok.map((r) => Math.round(100 * (1 - r[1] / r[2])))].sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  console.log(`\nMedian: ~${med}% fewer tokens than reading the raw log.`);
}
process.exit(0);
