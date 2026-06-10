#!/usr/bin/env node
// Self-contained eval for gamedev-log-analyzer. Generates a SYNTHETIC, sanitized log (no real project
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
const tmp = path.join(os.tmpdir(), "gamedev-log-eval-core.log");
fs.writeFileSync(tmp, log);
const viaCore = runTool("log_search", { path: tmp, severityMin: "Warning", groupBy: "callsite" });
// runTool prepends "Source: <path>\n" then the exact engine output → must end with it byte-for-byte.
const engineOut = analyzeLog(log, { severityMin: "Warning", groupBy: "callsite" });
const coreOk = !viaCore.isError && viaCore.text.endsWith(engineOut);
try { fs.unlinkSync(tmp); } catch { /* ignore */ }

// coverage hint: an unknown format (<40% parsed, ≥100 lines) gets a one-line nudge to the learnings
// ledger; a supported log does not. Guards the self-learning "surface the gap" behavior.
const junkPath = path.join(os.tmpdir(), "gamedev-log-eval-junk.log");
fs.writeFileSync(junkPath, Array.from({ length: 150 }, () => "random telemetry blob alpha 1 beta 2").join("\n"));
const hintOnUnknown = /Only \d+% of lines parsed/.test(runTool("log_summary", { path: junkPath }).text);
try { fs.unlinkSync(junkPath); } catch { /* ignore */ }
const covHintOk = hintOnUnknown && !/Only \d+% of lines parsed/.test(viaCore.text); // supported log → no hint

// Multi-engine classification — SYNTHETIC samples from each engine's documented format. UE + MSVC build
// are live-verified; Unity-deep + Godot are BEST-EFFORT (format from public docs, NOT verified against
// real Unity/Godot logs). This guards the documented shapes only, not real-world coverage.
const engineCases = [
  { line: "Assets/Game/Foo.cs(12,34): error CS1002: ; expected", sev: "Error", cat: "Build" }, // Unity C# compile
  { line: "MyLib.obj : error LNK2019: unresolved external symbol", sev: "Error", cat: "Build" }, // MSVC linker
  { line: "SCRIPT ERROR: Invalid call in base 'Node'.", sev: "Error", cat: "Godot" }, // Godot ⚠️ unverified
  { line: "USER WARNING: deprecated API used", sev: "Warning", cat: "Godot" }, // Godot ⚠️ unverified
  { line: "   at: Player._process (res://player.gd:42)", sev: "Display", cat: "Godot", loc: "res://player.gd:42" },
  { line: "NullReferenceException: Object reference not set", sev: "Error" }, // Unity runtime (generic)
  // JSONL — live-verified against a real UE AIMovementDebug .jsonl (severity from verbosity, category
  // from stage, message from message). bunyan/pino/serilog key aliases handled too.
  { line: '{"ts":17750181.6,"verbosity":"Log","stage":"ServerCMCPos","message":"[AISyncBlend] Pawn=X Vel=0"}', sev: "Display", cat: "ServerCMCPos" },
  { line: '{"level":"error","logger":"net","msg":"connection refused"}', sev: "Error", cat: "net" }, // bunyan/pino
  { line: '{"@l":"Warning","SourceContext":"App.Db","message":"slow query"}', sev: "Warning", cat: "App.Db" }, // serilog
  // Common text formats — BEST-EFFORT (not verified against a specific app's real logs).
  { line: "2024-01-02 03:04:05,123 - app.worker - ERROR - task failed", sev: "Error", cat: "app.worker" }, // python logging
  { line: "[WARN] disk almost full", sev: "Warning", cat: "Log" }, // bracketed level
];
const engineOk = engineCases.every((c) => {
  const e = parseLine(c.line);
  return e && e.severity === c.sev && (!c.cat || e.category === c.cat) && (!c.loc || e.location === c.loc);
});

// JSONL field extraction — the JSON `Actor=(x,y,z)` inside `message` + top-level `ts` must resolve so
// `log_fields` works on JSONL trace logs (live-verified on a real UE movement log).
const jsonlLog = [
  '{"ts":100.0,"verbosity":"Log","stage":"Pos","message":"Pawn=A Actor=(10.0, 20.0, 5.0) Vel=400"}',
  '{"ts":100.1,"verbosity":"Log","stage":"Pos","message":"Pawn=A Actor=(13.0, 24.0, 5.0) Vel=410"}',
].join("\n");
const jsonlOut = extractFields(jsonlLog, { fields: ["ts", "Actor.x", "Vel", "step:Actor"], category: "Pos", severityMin: "Display", max: 10 });
const jsonlOk = /(^|\n)100\t10\.0\t400\t/.test(jsonlOut) && /\t5\.00$/.test(jsonlOut); // step = hypot(3,4)=5.00

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
  ["multi-engine classify (synthetic)", engineOk, "true", engineOk],
  ["JSONL field extraction", jsonlOk, "true", jsonlOk],
  ["coverage hint (unknown fmt only)", covHintOk, "true", covHintOk],
];

console.log(`gamedev-log-analyzer eval — ${N} synthetic (sanitized) lines\n`);
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
