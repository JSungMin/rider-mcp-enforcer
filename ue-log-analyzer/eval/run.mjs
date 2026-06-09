#!/usr/bin/env node
// Self-contained eval for ue-log-analyzer. Generates a SYNTHETIC, sanitized log (no real project
// data) and measures the core promises: parse coverage, token reduction, dedup collapse, and
// field-extraction size. Exits non-zero if any metric falls below threshold — a regression guard
// and a measurable target for future self-improvement. No dependencies (pure logs.js); CI-friendly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeLog, extractFields, parseLine, diffLogs, locateLog } from "../server/logs.js";
import { runTool } from "../server/core.js";

// Deterministic synthetic UE-style log (generic names only).
function makeLog(n) {
  const out = [];
  const ms = (i) => String(i % 1000).padStart(3, "0");
  const fr = (i) => String(i % 600).padStart(4);
  for (let i = 0; i < n; i++) {
    const ts = (1000 + i * 0.016).toFixed(3);
    const actor = `Actor_${i % 12}`;
    const t = i % 10;
    if (t < 6) {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogMove: Display: Mover.cpp(566) Tick Pawn=${actor} ts=${ts} Pos=(${-(i % 500)}.0, ${i % 900}.0, 130.0) Alpha=${(i % 100) / 100}`);
    } else if (t < 9) {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogSync: Warning: Sync.cpp(120) Drift Pawn=${actor} ts=${ts} Gap=${i % 50}`);
    } else if (i % 50 === 0) {
      out.push(`Src/Build.cpp(${100 + (i % 30)}): error C2065: undeclared identifier`);
    } else {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogNull: Error: Null.cpp(45) null pointer id ${i}`);
    }
  }
  return out.join("\n");
}

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const N = 4000;
const log = makeLog(N);
const lines = log.split("\n");

let parsed = 0;
for (const l of lines) if (parseLine(l)) parsed++;
const coverage = parsed / lines.length;

const rawTok = tok(log);
const summary = analyzeLog(log, { severityMin: "Warning", maxGroups: 40, groupBy: "callsite" });
const sumTok = tok(summary);
const reduction = 1 - sumTok / rawTok;
const groups = (summary.match(/@ [\w./]+:\d+/g) || []).length;
const fieldsTok = tok(extractFields(log, { query: "Tick", fields: ["Pawn", "Alpha", "ts"], max: 20 }));

// diff: B = same run plus a handful of injected NEW errors. A near-identical pair must
// yield a near-empty diff — the delta-only token win vs re-summarizing the whole log.
const logB = makeLog(N)
  .split("\n")
  .map((l, i) => (i % 800 === 0 ? `[2024.01.01-00.00.00:000][   0]LogGpu: Error: Gpu.cpp(9) device removed during present` : l))
  .join("\n");
const diff = diffLogs(log, logB, { severityMin: "Warning" });
const diffTok = tok(diff);
const diffHasNew = /\+ NEW/.test(diff);
const diffVsRaw = 1 - diffTok / rawTok; // honest win: delta vs re-reading the whole log

// locate: jump list (distinct file:line only) must be a compact handoff and carry no message bodies.
const locate = locateLog(log, { severityMin: "Error", basename: true });
const locateTok = tok(locate);
const locateHasLoc = /\.cpp:\d+/.test(locate); // jumpable basename:line present
const locateNoBodies = !/undeclared identifier|null pointer/.test(locate); // no message text leaked

// hybrid wiring: the shared runTool() (used by BOTH the MCP server and the CLI) must dispatch and
// produce the same compact output as calling logs.js directly. Guards the core.js refactor.
const tmp = path.join(os.tmpdir(), "ue-log-eval-core.log");
fs.writeFileSync(tmp, log);
const viaCore = runTool("log_search", { path: tmp, severityMin: "Warning", groupBy: "callsite" });
// runTool prepends "Source: <path>\n" then the exact engine output → must end with it byte-for-byte.
const engineOut = analyzeLog(log, { severityMin: "Warning", groupBy: "callsite" });
const coreOk = !viaCore.isError && viaCore.text.endsWith(engineOut);
try { fs.unlinkSync(tmp); } catch { /* ignore */ }

const rows = [
  ["parse coverage", (coverage * 100).toFixed(1) + "%", "≥ 95%", coverage >= 0.95],
  ["token reduction (callsite)", (reduction * 100).toFixed(1) + "%", "≥ 90%", reduction >= 0.9],
  ["callsite groups", groups, "≤ 20", groups <= 20],
  ["log_fields tokens (20 rows)", fieldsTok, "≤ 400", fieldsTok <= 400],
  ["log_diff tokens (delta-only)", diffTok, "≤ 200", diffTok <= 200],
  ["log_diff surfaces NEW errors", diffHasNew, "true", diffHasNew],
  ["log_diff vs raw log", (diffVsRaw * 100).toFixed(1) + "%", "≥ 99%", diffVsRaw >= 0.99],
  ["runTool dispatch (MCP=CLI)", coreOk, "true", coreOk],
  ["log_locate tokens (jump list)", locateTok, "≤ 150", locateTok <= 150],
  ["log_locate has file:line", locateHasLoc, "true", locateHasLoc],
  ["log_locate omits bodies", locateNoBodies, "true", locateNoBodies],
];

console.log(`ue-log-analyzer eval — ${N} synthetic (sanitized) lines\n`);
let ok = true;
for (const [name, val, thr, pass] of rows) {
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(30)} ${String(val).padStart(8)}   ${thr}`);
  if (!pass) ok = false;
}
console.log(`\nraw ~${rawTok.toLocaleString()} tok → callsite summary ~${sumTok.toLocaleString()} tok`);
if (!ok) {
  console.error("\nEVAL FAILED: a metric fell below threshold.");
  process.exit(1);
}
console.log("EVAL PASSED.");
