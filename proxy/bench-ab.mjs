// A/B benchmark: codebase search WITHOUT this plugin (Arm A: raw ripgrep, what the model would
// receive) vs WITH it (Arm B: Rider MCP, summarized + token-capped). Reports only aggregate
// counts/sizes/timings — never file paths, code, or the query strings' results — so it is safe to
// run against a private project.
//
// Usage (from proxy/):
//   RIDER_MCP_SSE_URL="http://127.0.0.1:<port>/sse" \
//   RIDER_PROJECT_PATH="D:/Path/To/Project" \
//   Q="AActor,UObject,BeginPlay" \
//   [NARROW="Source"] [MAXR=50] [RUNS=2] [JSON=1] \
//   node bench-ab.mjs
//
// Pick public framework symbols (AActor, UObject, …) as queries to avoid embedding anything
// project-specific in committed results.
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const URL_ = process.env.RIDER_MCP_SSE_URL || "http://127.0.0.1:64342/sse";
const PP = (process.env.RIDER_PROJECT_PATH || "").replace(/\\/g, "/"); // Rider wants forward slashes
const QUERIES = (process.env.Q || "AActor,UObject,BeginPlay").split(",").map((s) => s.trim()).filter(Boolean);
const NARROW = process.env.NARROW || ""; // optional project-relative subdir for the "narrow grep" arm
const MAXR = parseInt(process.env.MAXR || "50", 10);
const RUNS = parseInt(process.env.RUNS || "2", 10);
const CC_GREP_CAP = 250; // Claude Code's built-in Grep tool caps output ≈250 lines
const AS_JSON = !!process.env.JSON;
const tok = (s) => Math.round(Buffer.byteLength(s, "utf8") / 4);
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

// Same summarization the proxy applies: keep `path:line  code`, cap to N, note the truncated tail.
function summarize(text, cap) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  const items = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!items) return text;
  const kept = items.slice(0, cap).map((it) => {
    const p = String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/");
    const line = it.startLine ?? it.line ?? "";
    const t = String(it.lineText ?? it.text ?? "").trim();
    return `${p}${line !== "" ? ":" + line : ""}${t ? "  " + t : ""}`;
  });
  let out = kept.join("\n");
  const extra = items.length - kept.length;
  if (extra > 0) out += `\n… ${extra} more truncated.`;
  return out;
}

// Arm A: raw ripgrep over a scope. Returns {lines, tok, ms} (no content retained). Runs through a
// shell so `rg` resolves to rg.exe on Windows (a bare spawn can't find it); scope is quoted for spaces.
function grepArm(query, scope) {
  const t0 = performance.now();
  const r = spawnSync(`rg -n --no-heading -- ${JSON.stringify(query)} ${JSON.stringify(scope)}`, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    shell: true,
  });
  const ms = Math.round(performance.now() - t0);
  if (r.error) console.error(`[bench] rg failed: ${r.error.message}`);
  const out = r.stdout || "";
  const lines = out ? out.split("\n").filter(Boolean).length : 0;
  const capped = out.split("\n").slice(0, CC_GREP_CAP).join("\n");
  return { lines, tok: tok(out), cappedTok: tok(capped), ms, ok: r.status === 0 || lines > 0 };
}

async function riderArm(client, name, query) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: { q: query, limit: 200, projectPath: PP } });
  const ms = Math.round(performance.now() - t0);
  const raw = (r.content || []).map((p) => p.text || "").join("\n");
  const err = /Illegal|Unable to determine|doesn't correspond|not connected/.test(raw) && raw.length < 400;
  let items = null;
  try { const j = JSON.parse(raw); if (Array.isArray(j.items)) items = j.items.length; } catch { /* non-list */ }
  return { rawTok: tok(raw), sumTok: tok(summarize(raw, MAXR)), items, ms, err };
}

const client = new Client({ name: "bench-ab", version: "0.0.1" }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL(URL_)));

const rows = [];
for (const q of QUERIES) {
  const whole = [];
  const narrow = [];
  const stext = [];
  const ssym = [];
  for (let i = 0; i < RUNS; i++) {
    whole.push(grepArm(q, PP));
    if (NARROW) narrow.push(grepArm(q, `${PP}/${NARROW}`));
    stext.push(await riderArm(client, "search_text", q));
    ssym.push(await riderArm(client, "search_symbol", q));
  }
  const pick = (arr, k) => median(arr.map((x) => x[k]));
  const row = {
    q,
    grepWholeLines: pick(whole, "lines"),
    grepWholeTok: pick(whole, "tok"),
    grepCappedTok: pick(whole, "cappedTok"),
    grepWholeMs: pick(whole, "ms"),
    grepNarrowTok: NARROW ? pick(narrow, "tok") : null,
    grepNarrowMs: NARROW ? pick(narrow, "ms") : null,
    textItems: stext[stext.length - 1].items,
    textRawTok: pick(stext, "rawTok"),
    textSumTok: pick(stext, "sumTok"),
    textMs: pick(stext, "ms"),
    textErr: stext.some((x) => x.err),
    symSumTok: pick(ssym, "sumTok"),
    symMs: pick(ssym, "ms"),
    symErr: ssym.some((x) => x.err),
  };
  rows.push(row);
}
await client.close();

if (AS_JSON) {
  console.log(JSON.stringify({ project: "(redacted)", queries: QUERIES.length, maxr: MAXR, runs: RUNS, rows }, null, 2));
  process.exit(0);
}

console.log(`A/B search benchmark — ${QUERIES.length} quer${QUERIES.length === 1 ? "y" : "ies"}, ${RUNS} run(s), cap=${MAXR}`);
console.log(`(token ≈ utf8 bytes ÷ 4; values are medians; no result content shown)\n`);
const pct = (a, b) => (a > 0 ? `${(100 * (1 - b / a)).toFixed(1)}%` : "—");
for (const r of rows) {
  const label = `Q="${r.q}"`;
  console.log(label);
  console.log(`  A · grep whole-project : ${r.grepWholeLines} lines, ~${r.grepWholeTok} tok, ${r.grepWholeMs} ms`);
  console.log(`  A · grep capped@${CC_GREP_CAP}     : ~${r.grepCappedTok} tok (what CC's Grep tool would deliver)`);
  if (NARROW) console.log(`  A · grep narrow (${NARROW}) : ~${r.grepNarrowTok} tok, ${r.grepNarrowMs} ms`);
  console.log(`  B · Rider search_text  : ${r.textErr ? "ERROR" : `${r.textItems ?? "?"} items → ~${r.textSumTok} tok summarized (raw ~${r.textRawTok}), ${r.textMs} ms`}`);
  console.log(`  B · Rider search_symbol: ${r.symErr ? "ERROR" : `~${r.symSumTok} tok summarized, ${r.symMs} ms`}`);
  if (!r.textErr) {
    console.log(`  → tokens vs whole-grep: ${pct(r.grepWholeTok, r.textSumTok)} fewer; vs capped grep: ${pct(r.grepCappedTok, r.textSumTok)} fewer`);
  }
  console.log("");
}
const okRows = rows.filter((r) => !r.textErr && r.grepWholeTok > 0);
if (okRows.length) {
  const savWhole = median(okRows.map((r) => Math.round(100 * (1 - r.textSumTok / r.grepWholeTok))));
  const savCap = median(okRows.map((r) => (r.grepCappedTok > 0 ? Math.round(100 * (1 - r.textSumTok / r.grepCappedTok)) : 0)));
  console.log(`AGGREGATE (median): ${savWhole}% fewer tokens vs whole-project grep, ${savCap}% fewer vs capped grep.`);
}
process.exit(0);
