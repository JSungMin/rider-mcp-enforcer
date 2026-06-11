/*
 * rider-mcp-enforcer — `discover`: scan the LOCAL Claude Code transcript(s) and report, in aggregate,
 * how many in-domain code searches bypassed rider-search vs went through it. Adapted from RTK's
 * `rtk discover`, scoped to OUR domain (code-symbol search only — never general command compression).
 *
 * SECURITY (standing rule): reads transcripts, never writes/transmits them, and emits ONLY aggregate
 * counts + coarse token estimates + category labels. It NEVER prints a command, file path, symbol, or
 * any code/log content — those can carry proprietary data. Output is stdout for the user's eyes only.
 *
 * HONESTY: output tokens are estimated as chars / CHARS_PER_TOKEN (a heuristic, not a real tokenizer),
 * reported coarsely (K-rounded) and labelled "estimated". "Reclaimable" is given as a range, not a point.
 * Raw reads are reported DESCRIPTIVELY ("bypassed"), not as "waste" — some are legitimate fallbacks.
 */
import { isCodeGrepTool, bashHasCodeSearch } from "../../hooks/detectors.js";

const CHARS_PER_TOKEN = 4; // rough char→token heuristic; NOT a tokenizer call
const PENDING_CAP = 5000; // bound the tool_use→result match map (memory guard on huge streams)

// Normalize a tool_result `content` to a character length. Claude Code encodes it as a string OR an
// array of {type,text,...} blocks (M4) — sum the text-block lengths; anything else → 0.
export function contentLen(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? b.text.length : 0), 0);
  }
  return 0;
}

// Rider classifiers (reuse the SAME detectors as the enforcement hook — single source of truth).
export function classifyBypassRider(name, input) {
  if (name === "Bash") return bashHasCodeSearch(input && input.command) ? "bash" : null;
  if (name === "Grep") return isCodeGrepTool(input) ? "grep" : null;
  return null;
}
// A code search that DID go through the plugin = a rider-search MCP search tool call.
export function isCapturedRider(name) {
  return typeof name === "string" && /rider-search__(search_symbol|search_text|search_regex|search_in_files_by)/.test(name);
}

// Streaming analyzer: feed one parsed JSONL record at a time; counts captured at tool_use, and bypass
// at tool_result (where the real output size is), keyed back through a bounded pending map. is_error
// results are excluded (an errored read didn't dump a full payload into context).
export function makeAnalyzer({ classifyBypass, isCaptured }) {
  const pending = new Map();
  const bypass = {};
  let capturedCount = 0;
  let recognized = 0;
  let lines = 0;

  const bump = (kind, outChars) => {
    const t = bypass[kind] || (bypass[kind] = { count: 0, outChars: 0 });
    t.count++;
    t.outChars += outChars;
  };

  function feed(rec) {
    lines++;
    const msg = rec && (rec.message || rec);
    const content = msg && msg.content;
    if (!Array.isArray(content)) return; // skip summary/meta/non-message lines
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "tool_use") {
        recognized++;
        if (isCaptured(c.name, c.input)) {
          capturedCount++;
          continue;
        }
        const kind = classifyBypass(c.name, c.input);
        if (kind && c.id) {
          if (pending.size >= PENDING_CAP) pending.clear();
          pending.set(c.id, kind);
        }
      } else if (c.type === "tool_result") {
        const kind = pending.get(c.tool_use_id);
        if (!kind) continue;
        pending.delete(c.tool_use_id);
        if (c.is_error) continue;
        bump(kind, contentLen(c.content));
      }
    }
  }

  return { feed, result: () => ({ bypass, capturedCount, recognized, lines }) };
}

// Parse a JSONL string and run the rider analyzer over it (sync; for tests + small files). The CLI
// streams large files line-by-line through makeAnalyzer instead of buffering the whole thing.
export function analyzeJsonl(text) {
  const a = makeAnalyzer({ classifyBypass: classifyBypassRider, isCaptured: isCapturedRider });
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // fail-open on a bad line
    }
    a.feed(rec);
  }
  return a.result();
}

const kTok = (chars) => Math.round(chars / CHARS_PER_TOKEN / 1000); // coarse K-tokens

// Render the aggregate report. SANITIZED: counts + coarse token estimates + labels only.
export function formatRiderReport(result, { scope = "this project" } = {}) {
  // M5 — a non-empty transcript with zero recognizable tool_use means the format changed; do NOT
  // report "0 bypassed" (which reads as "perfectly efficient" — the worst false signal).
  if (result.lines > 0 && result.recognized === 0) {
    return "rider discover: transcript format not recognized (Claude Code may have changed its log format) — skipping, no estimate produced.";
  }
  const bash = result.bypass.bash || { count: 0, outChars: 0 };
  const grep = result.bypass.grep || { count: 0, outChars: 0 };
  const bypassCount = bash.count + grep.count;
  const captured = result.capturedCount;
  const total = bypassCount + captured;
  if (total === 0) {
    return `rider discover (${scope}): no in-domain code searches found in the transcript — nothing to report.`;
  }
  const outK = kTok(bash.outChars + grep.outChars);
  const pct = Math.round((captured / total) * 100);
  const out = [];
  out.push(`rider discover — ${scope}  (estimated; output tokens ≈ chars/${CHARS_PER_TOKEN})`);
  out.push("──────────────────────────────────────────────");
  out.push(`Code searches that bypassed rider-search : ${bypassCount}  (~${outK}K tok of output reached context, measured)`);
  out.push(`    • Bash grep/rg/find over source : ${bash.count}`);
  out.push(`    • Grep tool over code           : ${grep.count}`);
  out.push(`Code searches routed through rider-search : ${captured}   → coverage ${pct}%`);
  out.push("──────────────────────────────────────────────");
  if (outK >= 1) {
    out.push(`Est. reclaimable if routed through rider-search: ~${Math.max(1, outK - 2)}K–${outK}K tok (rider caps results; estimate).`);
  }
  out.push("Tip: route code-symbol search through rider-search / the code-locator subagent.");
  out.push("Note: some raw reads may have been intentional fallbacks (just-edited / unindexed files).");
  return out.join("\n");
}
