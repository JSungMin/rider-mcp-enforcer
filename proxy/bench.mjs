// Benchmark Rider MCP (raw + proxy-summarized) token/time for one query.
// Usage: RIDER_MCP_SSE_URL=... RIDER_PROJECT_PATH=... Q=MyClass node bench.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const URL_ = process.env.RIDER_MCP_SSE_URL || "http://127.0.0.1:64342/sse";
const PP = process.env.RIDER_PROJECT_PATH || "";
const Q = process.env.Q || "MyClass";
const MAX = parseInt(process.env.MAXR || "50", 10);
const tok = (s) => Math.round(Buffer.byteLength(s, "utf8") / 4);

function summarize(text, cap) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  const items = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!items) return text;
  const kept = items.slice(0, cap).map((it) => {
    const p = String(it.filePath ?? it.path ?? "").replace(/\\/g, "/");
    const line = it.startLine ?? it.line ?? "";
    const t = String(it.lineText ?? it.text ?? "").trim();
    return `${p}${line !== "" ? ":" + line : ""}${t ? "  " + t : ""}`;
  });
  let out = kept.join("\n");
  const extra = items.length - kept.length;
  if (extra > 0) out += `\n… ${extra} more truncated.`;
  return out;
}

const c = new Client({ name: "bench", version: "0.0.1" }, { capabilities: {} });
await c.connect(new SSEClientTransport(new URL(URL_)));

async function bench(name, args) {
  const t0 = performance.now();
  const r = await c.callTool({ name, arguments: PP ? { ...args, projectPath: PP } : args });
  const ms = Math.round(performance.now() - t0);
  const raw = (r.content || []).map((p) => p.text || "").join("\n");
  const summarized = summarize(raw, MAX);
  let items = "?";
  try { const j = JSON.parse(raw); if (Array.isArray(j.items)) items = j.items.length + (j.more ? "+" : ""); } catch {}
  console.log(
    `${name.padEnd(14)} time=${ms}ms  items=${items}  raw=~${tok(raw)}tok  summarized=~${tok(summarized)}tok`
  );
}

console.log(`Query="${Q}"  project=${PP || "(default)"}  cap=${MAX}\n`);
for (let i = 0; i < 2; i++) {
  console.log(`-- run ${i + 1} --`);
  await bench("search_symbol", { q: Q, limit: 200 });
  await bench("search_text", { q: Q, limit: 200 });
}
await c.close();
process.exit(0);
