#!/usr/bin/env node
// Print cumulative token savings recorded by the proxy. Standalone (no Rider needed).
// Usage: node stats.mjs        (or set RIDER_STATS_FILE to a custom ledger path)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATS_FILE =
  process.env.RIDER_STATS_FILE ||
  path.join(os.homedir(), ".rider-mcp-enforcer", "stats.json");

let s;
try {
  s = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
} catch {
  console.log(`No savings recorded yet (ledger: ${STATS_FILE}).`);
  process.exit(0);
}
const saved = s.rawTokens - s.sentTokens;
const pct = s.rawTokens ? Math.round((saved / s.rawTokens) * 100) : 0;
console.log(`rider-mcp-enforcer — cumulative token savings (vs Rider raw responses)`);
console.log(`  summarized calls : ${s.calls}`);
console.log(`  raw tokens       : ~${s.rawTokens.toLocaleString()}`);
console.log(`  sent tokens      : ~${s.sentTokens.toLocaleString()}`);
console.log(`  saved            : ~${saved.toLocaleString()} (${pct}%)`);
console.log(`  noise items dropped: ${s.excludedItems ?? 0}`);
console.log(`  since            : ${s.since || "—"}`);
console.log(`  ledger           : ${STATS_FILE}`);
