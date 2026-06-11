#!/usr/bin/env node
/*
 * rider-search-proxy
 * ------------------
 * An MCP server (stdio, for Claude Code) that is also an MCP client (SSE) to
 * JetBrains Rider's built-in MCP server. It forwards every tool call to Rider,
 * but SUMMARIZES any high-fan-out search response (this Rider build exposes
 * search_symbol, search_text, search_regex, search_in_files_by_text/regex, …) down
 * to `file:line` lines and caps the count, so a find-usages flood on a large Unreal
 * C++ codebase cannot blow up the context. Summarization is decided by RESPONSE
 * SHAPE (any Rider `{items:[…]}` list), so it auto-adapts to Rider's tool names with
 * zero config and never mangles non-list tools like read_file.
 *
 * Config (env):
 *   RIDER_MCP_SSE_URL     Rider MCP SSE URL. Rider -> Settings | Tools | MCP Server
 *                         -> Enable -> "Copy SSE Config". Required.
 *   RIDER_MAX_RESULTS     Max lines kept per summarized response (default 50).
 *   RIDER_SUMMARIZE_TOOLS Optional allow-list of Rider tool names to RESTRICT
 *                         summarization to (back-compat). Unset (default) =
 *                         summarize any list response.
 */

import {
  Client,
  SSEClientTransport,
  Server,
  StdioServerTransport,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "./sdk.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { regenProject, verifyNote } from "./regen.mjs";

// Settings come from (highest precedence first): environment variable > config file
// (~/.rider-mcp-enforcer/config.json, written by the setup command) > built-in default.
const CONFIG_DIR = path.join(os.homedir(), ".rider-mcp-enforcer");
const CONFIG_FILE = process.env.RIDER_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
} catch {
  /* no config file yet — env + defaults */
}
function cfg(envName, key, def) {
  const e = process.env[envName];
  if (e !== undefined && e !== "") return e;
  const v = fileCfg[key];
  if (v !== undefined && v !== null && v !== "") return v;
  return def;
}
const isOff = (v) => ["0", "false", "off"].includes(String(v).toLowerCase());
const isOn = (v) => ["1", "true", "on"].includes(String(v).toLowerCase());

const RIDER_URL = cfg("RIDER_MCP_SSE_URL", "riderSseUrl", "");
const MAX_RESULTS = parseInt(cfg("RIDER_MAX_RESULTS", "maxResults", "50"), 10) || 50;
const PROJECT_PATH = cfg("RIDER_PROJECT_PATH", "projectPath", "");
const ESCALATE = !isOff(cfg("RIDER_ESCALATE", "escalate", "1"));
const ESCALATE_LIMIT = parseInt(cfg("RIDER_ESCALATE_LIMIT", "escalateLimit", "500"), 10) || 500;
const MAX_LINE_CHARS = parseInt(cfg("RIDER_MAX_LINE_CHARS", "maxLineChars", "200"), 10) || 200;
const EXCLUDE_OFF = isOn(cfg("RIDER_EXCLUDE_OFF", "excludeOff", ""));
const EXCLUDE = String(
  cfg(
    "RIDER_EXCLUDE",
    "exclude",
    "/intermediate/,/binaries/,/build/,/saved/,/deriveddatacache/,/.vs/,/.idea/,/node_modules/,.vcxproj,.sln,.filters"
  )
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const STATS_FILE = cfg("RIDER_STATS_FILE", "statsFile", path.join(CONFIG_DIR, "stats.json"));
// rider_regen_project (project-file regeneration) settings.
const REGEN_CMD = cfg("RIDER_REGEN_CMD", "regenCmd", ""); // explicit command template; bypasses auto-detect
const ENGINE_PATH = cfg("RIDER_ENGINE_PATH", "enginePath", ""); // engine dir override for auto-detect
const REGEN_TIMEOUT = parseInt(cfg("RIDER_REGEN_TIMEOUT", "regenTimeout", "300000"), 10) || 300000;
// What gets summarized is decided by the RESPONSE SHAPE, not the tool name: a response that parses
// as Rider's list JSON (`{items:[...]}`) is compacted; anything else (file contents, status, etc.)
// passes through untouched. This auto-adapts to Rider version/tool changes with zero config and
// cannot mangle non-list tools like read_file. Optional RIDER_SUMMARIZE_TOOLS restricts which tool
// names may be summarized (back-compat); unset = summarize any list response.
const SUMMARIZE_RESTRICT = (() => {
  const raw = process.env.RIDER_SUMMARIZE_TOOLS ?? fileCfg.summarizeTools;
  if (raw === undefined || raw === null || raw === "") return null;
  return new Set(String(raw).split(",").map((s) => s.trim()).filter(Boolean));
})();
// Name heuristic used ONLY for the cosmetic "[PREFERRED]" hint in the tool list.
const SEARCHY_NAME_RE = /(^|_)(search|find)(_|$)|usage|reference|symbol/i;
let limitTools = new Set(); // tools whose inputSchema has a `limit` property (gates auto-escalation)
function learnToolMap(tools) {
  limitTools = new Set(
    tools
      .filter((t) => t && t.inputSchema && t.inputSchema.properties && "limit" in t.inputSchema.properties)
      .map((t) => t.name)
  );
}
const isSummarizable = (name, info) => !!info && (!SUMMARIZE_RESTRICT || SUMMARIZE_RESTRICT.has(name));

const log = (...a) => console.error("[rider-search-proxy]", ...a);

// ---- setup / config (written by the setup command, read at proxy startup) ----
const CONFIG_KEYS = [
  "riderSseUrl", "projectPath", "maxResults", "escalate", "escalateLimit",
  "maxLineChars", "exclude", "excludeOff", "summarizeTools", "statsFile",
  "regenCmd", "enginePath", "regenTimeout",
];
function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}
function applySetup(args) {
  const current = readConfigFile();
  const changed = [];
  for (const k of CONFIG_KEYS) {
    if (args[k] !== undefined) {
      current[k] = args[k];
      changed.push(k);
    }
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  return { current, changed };
}
function effectiveConfig() {
  return {
    riderSseUrl: RIDER_URL || "(unset)",
    projectPath: PROJECT_PATH || "(unset)",
    maxResults: MAX_RESULTS,
    escalate: ESCALATE,
    escalateLimit: ESCALATE_LIMIT,
    maxLineChars: MAX_LINE_CHARS,
    excludeOff: EXCLUDE_OFF,
    exclude: EXCLUDE,
    statsFile: STATS_FILE,
  };
}
async function httpProbe(url, ms = 1500) {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), ms);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    return res.status; // any HTTP status means something is listening
  } catch {
    return 0;
  }
}
// Detect the Rider MCP SSE endpoint, and whether the Rider IDE itself seems to be up
// (its built-in web server answers even when the MCP server is off) — so we can tell
// "running but MCP off" from "Rider not running".
async function detectRider() {
  const sseCandidates = ["http://127.0.0.1:64342/sse", "http://127.0.0.1:63342/sse"];
  const sseUrls = [];
  for (const u of sseCandidates) {
    const s = await httpProbe(u);
    if (s >= 200 && s < 400) sseUrls.push(u);
  }
  let riderUp = sseUrls.length > 0;
  if (!riderUp) {
    for (const p of [63342, 64342]) {
      if (await httpProbe(`http://127.0.0.1:${p}/`)) {
        riderUp = true;
        break;
      }
    }
  }
  return { sseUrls, riderUp };
}
// Build a clear, actionable activation card for when Rider MCP is unreachable.
function enableCard({ sseUrls, riderUp }) {
  if (sseUrls.length) {
    return (
      `✅ Rider MCP SSE detected: ${sseUrls.join(", ")}\n` +
      `Apply it: rider_setup { "riderSseUrl": "${sseUrls[0]}" }  →  then /reload-plugins.`
    );
  }
  const steps = [];
  if (!riderUp) steps.push("Start JetBrains Rider (2025.2+) and open your project.");
  steps.push('Rider → Settings | Tools | MCP Server → tick "Enable MCP Server".');
  steps.push('Click "Copy SSE Config", then run: rider_setup { "riderSseUrl": "<that URL>" }.');
  steps.push("Run /reload-plugins.");
  const head = riderUp
    ? "⚠ Rider is running, but its MCP server is OFF."
    : "⚠ Rider does not appear to be running.";
  return (
    head +
    "\n\nEnable it:\n" +
    steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
    "\n\nNot ready to enable? Set RIDER_ENFORCE=0 so Bash grep isn't blocked in the meantime."
  );
}

async function connectRider() {
  if (!RIDER_URL) {
    log("RIDER_MCP_SSE_URL not set — every call returns setup instructions.");
    return null;
  }
  const client = new Client(
    { name: "rider-search-proxy", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(new SSEClientTransport(new URL(RIDER_URL)));
  log("connected to Rider MCP:", RIDER_URL);
  return client;
}

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);

// Rider builds a file:// URI from projectPath; a Windows backslash path throws "Illegal character
// in authority". Forward slashes resolve on every platform. Exported for tests.
export function normalizeProjectPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/") : p;
}

export function isExcluded(p) {
  if (EXCLUDE_OFF) return false;
  const lp = p.toLowerCase();
  return EXCLUDE.some((x) => lp.includes(x));
}

// A log-ish path: a Logs/ (or Saved/Logs/) dir, or a file ending in .log/.jsonl/.log.N. Used to steer
// a log-analysis call AWAY from Rider — Rider's code index excludes Saved/ (see EXCLUDE) and isn't a log
// parser, so a search/read aimed at a log returns empty/"not a directory"/"doesn't exist" here. Route
// those to gamedev-log instead.
const LOG_PATHISH = /(^|[/\\])(saved[/\\])?logs[/\\]|\.(log|jsonl)(\.\d+)?$/i;
export function looksLogTarget(args) {
  if (!args || typeof args !== "object") return false;
  const vals = [args.path, args.pathInProject, args.filePath, args.directory, args.dir, args.paths]
    .flat()
    .filter((v) => typeof v === "string");
  return vals.some((v) => LOG_PATHISH.test(v));
}

// Resolve any path-ish arg to an ABSOLUTE path that exists on disk (against the project root for
// relative pathInProject), or null. Used to tell "Rider's model is stale" apart from "really gone".
export function resolveExistingPath(args, projectRoot) {
  if (!args || typeof args !== "object") return null;
  const cands = [args.filePath, args.pathInProject, args.path, args.directory, args.dir]
    .concat(Array.isArray(args.paths) ? args.paths : [args.paths])
    .filter((v) => typeof v === "string" && v.trim());
  for (const c of cands) {
    const norm = c.replace(/\\/g, "/");
    const abs = path.isAbsolute(norm) ? norm : projectRoot ? path.join(projectRoot, norm) : norm;
    try {
      if (fs.existsSync(abs)) return abs.replace(/\\/g, "/");
    } catch {
      /* unstattable — skip */
    }
  }
  return null;
}

// Rider reporting a path as missing / not-a-directory / empty-not-found.
const MISSING_RE = /does(?:n'?t| not)\s*exist|not a directory|no such file|cannot find|couldn'?t find|not found/i;
export function resultSaysMissing(result) {
  if (!result || !Array.isArray(result.content)) return false;
  const txt = result.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
  return MISSING_RE.test(txt);
}

// THE strong stale-project signal: Rider says the path is missing, but it EXISTS on disk. That means
// new/moved/renamed source files since the last GenerateProjectFiles — Rider's project model is stale,
// not the code. Steer to a re-generate (the rider_regen_project helper, or a manual UBT -projectfiles).
export function staleProjectNote(result, args, projectRoot) {
  if (!resultSaysMissing(result)) return "";
  const onDisk = resolveExistingPath(args, projectRoot);
  if (!onDisk) return "";
  return (
    "\n\n⚠ Stale project files: `" + onDisk + "` EXISTS on disk but Rider's project model doesn't have it " +
    "— i.e. files were added/moved/renamed since the last project-file generation, so Rider can't index it " +
    "yet. Re-generate so Rider re-indexes: run the `rider_regen_project` tool (or, manually, " +
    "GenerateProjectFiles / `Build.bat -projectfiles -project=<.uproject>`). Until then this path stays invisible here."
  );
}

function readStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {
    return { calls: 0, rawTokens: 0, sentTokens: 0, excludedItems: 0, since: null };
  }
}
function writeStats(s) {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* stats are best-effort */
  }
}
function recordSavings(rawTok, sentTok, excludedItems) {
  const s = readStats();
  if (!s.since) s.since = new Date().toISOString();
  s.calls += 1;
  s.rawTokens += rawTok;
  s.sentTokens += sentTok;
  s.excludedItems += excludedItems || 0;
  writeStats(s);
}
function savingsReport() {
  const s = readStats();
  const saved = s.rawTokens - s.sentTokens;
  const pct = s.rawTokens ? Math.round((saved / s.rawTokens) * 100) : 0;
  return (
    `rider-mcp-enforcer — cumulative token savings (vs forwarding Rider's raw responses)\n` +
    `  summarized calls : ${s.calls}\n` +
    `  raw tokens       : ~${s.rawTokens.toLocaleString()}\n` +
    `  sent tokens      : ~${s.sentTokens.toLocaleString()}\n` +
    `  saved            : ~${saved.toLocaleString()} (${pct}%)\n` +
    `  noise items dropped (build artifacts): ${s.excludedItems}\n` +
    `  since            : ${s.since || "—"}\n` +
    `  ledger           : ${STATS_FILE}`
  );
}

// Fallback: reduce plain-text content to <= MAX_RESULTS non-empty lines + footer.
export function summarizeLines(part) {
  const lines = part.text.split(/\r?\n/).filter((l) => l.trim().length);
  const kept = lines.slice(0, MAX_RESULTS).map((l) => l.trim());
  let text = kept.join("\n");
  const extra = lines.length - kept.length;
  if (extra > 0) text += `\n… ${extra} more line(s) truncated by rider-search-proxy.`;
  return { type: "text", text: text || part.text };
}

// Rider search/symbol tools return JSON: {"items":[{filePath,startLine,lineText,...}],"more":bool}.
// Extract {items, more} from the first JSON text part, or null if not that shape.
export function parseSearch(result) {
  if (!result || !Array.isArray(result.content)) return null;
  for (const part of result.content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(part.text);
    } catch {
      return null;
    }
    const items = Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed)
      ? parsed
      : null;
    if (!items) return null;
    return { items, more: parsed?.more === true };
  }
  return null;
}

export function itemLine(it) {
  const p = String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/");
  const line = it.startLine ?? it.line ?? "";
  let txt = String(it.lineText ?? it.text ?? "").trim();
  if (txt.length > MAX_LINE_CHARS) txt = txt.slice(0, MAX_LINE_CHARS) + " …(trimmed)";
  return `${p}${line !== "" ? ":" + line : ""}${txt ? "  " + txt : ""}`;
}

// Compact items to `path:line  lineText`, cap at MAX_RESULTS. When the result is NOT
// exhaustive (more items fetched than shown, OR Rider still reports `more`), emit a LOUD
// INCOMPLETE banner with explicit options so Claude escalates to the user instead of
// treating a partial set as the full reference list.
export function summarizeSearch(info, { escalated, fetchedLimit, name } = {}) {
  const kept0 = info.items.filter(
    (it) => !isExcluded(String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/"))
  );
  const excluded = info.items.length - kept0.length;
  const shown = Math.min(kept0.length, MAX_RESULTS);
  const hidden = kept0.length - shown;
  const incomplete = hidden > 0 || info.more;
  const lines = kept0.slice(0, MAX_RESULTS).map(itemLine);
  // Empty result: say the honest thing about WHY it might be empty, so a stale-index miss on a
  // just-saved file doesn't get read as "this symbol doesn't exist" → model losing trust in Rider
  // and defaulting to grep forever. Rider only searches finished-indexing projects, and its index
  // lags fresh saves, so on a just-edited file grep IS the right fallback; on established code an
  // empty result is a real answer. For a symbol tool, also point at the text tools (symbol search
  // matches definitions, not every reference).
  if (lines.length === 0) {
    const isSymbolTool = /symbol/i.test(String(name || ""));
    return {
      text:
        "(no results)\n" +
        "If you JUST created or edited the target file, Rider's index may lag the save — re-running " +
        "with Grep on THAT file is the correct fallback here, not a tool failure. For already-indexed " +
        "code, an empty result is a real answer. Looking for something that lives in LOGS? Saved/Logs is " +
        "excluded from the code index — use gamedev-log for log analysis, not rider." +
        (isSymbolTool
          ? " Note: symbol search matches DEFINITIONS; if the name may appear only as a reference/usage, " +
            "try search_text / search_regex (indexed string match)."
          : ""),
      excluded,
    };
  }
  let text = lines.join("\n");
  if (excluded > 0) {
    text +=
      `\n(${excluded} build-artifact/generated path(s) hidden by default exclude; ` +
      `set RIDER_EXCLUDE_OFF=1 to include them.)`;
  }
  if (incomplete) {
    const total = info.more ? `${kept0.length}+` : `${kept0.length}`;
    text +=
      `\n\n⚠ INCOMPLETE RESULTS — showing ${shown} of ${total} match(es)` +
      (escalated ? ` (proxy already auto-raised the limit to ${fetchedLimit})` : "") +
      `.\nThis list is NOT exhaustive. Do NOT use it as the complete set for finding all` +
      ` references, refactoring, or renaming — you may miss call sites and write wrong code.\n` +
      `Ask the USER to choose one:\n` +
      `  1) raise the cap (set RIDER_MAX_RESULTS higher, or pass a larger \`limit\`) to see all,\n` +
      `  2) narrow the search (pass \`paths\` to a subdirectory), or\n` +
      `  3) explicitly confirm a partial/representative result is acceptable for this task.`;
  }
  return { text: text || "(no results)", excluded };
}

// Public entry: summarize a (possibly escalated) result for a search tool + record savings.
export function summarize(result, meta = {}) {
  const info = parseSearch(result);
  if (!info) return result; // not a list response → pass through untouched (never trim file contents)
  const { text, excluded } = summarizeSearch(info, meta);
  const rawTok = tok((result.content || []).map((p) => p.text || "").join("\n"));
  const sentTok = tok(text);
  recordSavings(rawTok, sentTok, excluded);
  // Per-call positive signal (parity with gamedev-log's "✓ Saved" line): show the win only when it's
  // non-trivial, so a small result doesn't get a noisy footer. Doubles as a "Rider is working" cue —
  // the absence of this line on a connected search is itself a hint the result was already tiny.
  const saved = rawTok - sentTok;
  const withLine =
    saved >= 500
      ? `${text}\n\n✓ Saved ~${saved.toLocaleString()} tokens here (Rider index, summarized vs raw response).`
      : text;
  return { ...result, content: [{ type: "text", text: withLine }] };
}

const SETUP_RESULT = {
  isError: true,
  content: [
    {
      type: "text",
      text:
        "rider-search-proxy is not connected to Rider's MCP server. Call the rider_enable tool for a " +
        "guided activation (it probes Rider, gives the exact enable steps, and the SSE URL to apply). " +
        "Don't want to enable it now? Set RIDER_ENFORCE=0 so Bash grep isn't blocked, and use grep for " +
        "this turn.",
    },
  ],
};

async function main() {
  let rider = await connectRider().catch((e) => {
    log("Rider connect failed:", e.message);
    return null;
  });

  // Option V — best-effort re-probe: does Rider's project model now contain the file at `p`? Searches by
  // basename (find_files_by_name_keyword / search_file — robust to the pathInProject base quirk that makes
  // get_file_text_by_path unreliable). Returns {visible} or null (Rider down / probe failed / unknown).
  async function riderSeesFile(p) {
    if (!rider) return null;
    const base = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop();
    if (!base) return null;
    const baseLc = base.toLowerCase();
    for (const attempt of [
      { name: "find_files_by_name_keyword", arguments: { keyword: base, projectPath: PROJECT_PATH || undefined } },
      { name: "search_file", arguments: { query: base, projectPath: PROJECT_PATH || undefined } },
    ]) {
      try {
        const r = await rider.callTool(attempt);
        const info = parseSearch(r);
        if (info) {
          return {
            visible: info.items.some((it) =>
              String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/").toLowerCase().endsWith(baseLc)
            ),
          };
        }
        const txt = ((r && r.content) || []).map((c) => (c && c.text) || "").join("\n");
        if (txt && !/does(?:n'?t| not)\s*exist|not found|no such|unknown tool/i.test(txt)) {
          return { visible: txt.toLowerCase().includes(baseLc) };
        }
      } catch {
        /* try the next probe tool */
      }
    }
    return null;
  }

  const server = new Server(
    { name: "rider-search", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const SAVINGS_TOOLS = [
    {
      name: "rider_setup",
      description:
        "Configure this plugin's settings (writes ~/.rider-mcp-enforcer/config.json; read at proxy " +
        "startup, so run /reload-plugins after). Pass only the keys to change. Use for the setup command.",
      inputSchema: {
        type: "object",
        properties: {
          riderSseUrl: { type: "string", description: "Rider MCP SSE URL (Copy SSE Config)" },
          projectPath: { type: "string", description: "Default project root for searches" },
          maxResults: { type: "number", description: "Max lines shown per result (default 50)" },
          escalate: { type: "boolean", description: "Auto-raise limit once on truncation (default true)" },
          escalateLimit: { type: "number", description: "Limit used on auto-escalation (default 500)" },
          maxLineChars: { type: "number", description: "Max chars per snippet (default 200)" },
          exclude: { type: "string", description: "Comma list of path substrings to drop (build artifacts)" },
          excludeOff: { type: "boolean", description: "Keep excluded paths in results" },
          summarizeTools: { type: "string", description: "Comma list of Rider tool names to summarize" },
          statsFile: { type: "string", description: "Path for the savings ledger" },
          regenCmd: { type: "string", description: "rider_regen_project: explicit command template ({uproject}/{engine} tokens); bypasses auto-detect" },
          enginePath: { type: "string", description: "rider_regen_project: Unreal engine dir override for auto-detect" },
          regenTimeout: { type: "number", description: "rider_regen_project: max ms for a regen (default 300000)" },
        },
      },
    },
    {
      name: "rider_config",
      description: "Show the plugin's current effective settings and the config-file path.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rider_detect",
      description: "Probe localhost for a running Rider MCP SSE endpoint and suggest riderSseUrl.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rider_enable",
      description:
        "Guided activation when Rider MCP is off: probes whether Rider is running vs its MCP server is " +
        "disabled, returns the exact enable steps + the SSE URL to apply (and the RIDER_ENFORCE=0 " +
        "fallback). Use when search tools report 'not connected'.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rider_savings",
      description:
        "Report cumulative tokens this plugin saved (vs forwarding Rider's raw responses) " +
        "plus number of build-artifact noise items dropped. Use when the user asks how much was saved.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rider_savings_reset",
      description: "Reset the cumulative token-savings ledger to zero.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rider_regen_project",
      description:
        "Regenerate Unreal project files so Rider re-indexes after source files were added/moved/renamed " +
        "(fixes 'doesn't exist'/empty search results from a stale project model). SAFE BY DEFAULT: the " +
        "call WITHOUT confirm is a DRY RUN that resolves the .uproject + engine + exact command and shows " +
        "them — it runs nothing. Review, then call again with confirm:true to execute (confirm is required " +
        "even with RIDER_REGEN_CMD). Auto-detect is Windows-only; set RIDER_REGEN_CMD / RIDER_ENGINE_PATH " +
        "if resolution is wrong. Prefer no MCP shell-approval prompt? Run the CLI: node <plugin>/proxy/regen.mjs.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string", description: "Project root or .uproject (else RIDER_PROJECT_PATH)" },
          confirm: { type: "boolean", description: "Actually run the regen (default false = dry run)" },
          force: { type: "boolean", description: "Run even if a regen lock is present" },
          verifyPath: { type: "string", description: "After a confirmed regen, re-probe Rider for this file and report whether it's now visible (needs Rider connected). Pass the path that was missing." },
        },
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!rider) {
      return {
        tools: [
          ...SAVINGS_TOOLS,
          {
            name: "rider_status",
            description:
              "Rider MCP is not connected (set RIDER_MCP_SSE_URL). For symbol/definition/" +
              "usage/file lookups, prefer Rider tools over Bash grep once connected.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }
    const { tools } = await rider.listTools();
    learnToolMap(tools); // auto-derive the summarize set + limit-capable tools from the live list
    return {
      tools: [
        ...SAVINGS_TOOLS,
        ...tools.map((t) => ({
          ...t,
          description:
            (SEARCHY_NAME_RE.test(t.name)
              ? "[PREFERRED over Bash grep — Rider live index, summarized & token-capped] "
              : "") + (t.description || ""),
        })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Synthetic local tools (work even when Rider is disconnected).
    if (req.params.name === "rider_setup") {
      const { current, changed } = applySetup(req.params.arguments || {});
      return {
        content: [
          {
            type: "text",
            text:
              (changed.length
                ? `Updated ${changed.join(", ")}.`
                : "No recognized keys provided; nothing changed.") +
              `\nConfig written to ${CONFIG_FILE}:\n${JSON.stringify(current, null, 2)}\n\n` +
              `Run /reload-plugins (or restart Claude Code) to apply — settings are read at proxy startup.`,
          },
        ],
      };
    }
    if (req.params.name === "rider_config") {
      return {
        content: [
          {
            type: "text",
            text:
              `Effective settings (env > config file > default):\n` +
              JSON.stringify(effectiveConfig(), null, 2) +
              `\n\nConfig file: ${CONFIG_FILE}`,
          },
        ],
      };
    }
    if (req.params.name === "rider_detect" || req.params.name === "rider_enable") {
      const probe = await detectRider();
      return { content: [{ type: "text", text: enableCard(probe) }] };
    }
    if (req.params.name === "rider_savings") {
      return { content: [{ type: "text", text: savingsReport() }] };
    }
    if (req.params.name === "rider_savings_reset") {
      writeStats({ calls: 0, rawTokens: 0, sentTokens: 0, excludedItems: 0, since: new Date().toISOString() });
      return { content: [{ type: "text", text: "rider-mcp-enforcer savings ledger reset." }] };
    }
    if (req.params.name === "rider_regen_project") {
      const a = req.params.arguments || {};
      // The regen itself shells out to the engine's generator (works without Rider connected).
      let res = regenProject(a, {
        projectPath: PROJECT_PATH,
        configDir: CONFIG_DIR,
        regenCmd: REGEN_CMD,
        engineOverride: ENGINE_PATH,
        timeoutMs: REGEN_TIMEOUT,
      });
      // Option V — verify: after a real, successful run, re-probe Rider for the previously-missing file
      // (Rider exposes no reload trigger, so we verify rather than force). Best-effort: any failure → null.
      if (a.confirm === true && !res.isError && a.verifyPath && rider) {
        const verdict = await riderSeesFile(a.verifyPath);
        const note = verifyNote(a.verifyPath, verdict);
        if (note && Array.isArray(res.content) && res.content[0]) {
          res = { ...res, content: [{ ...res.content[0], text: (res.content[0].text || "") + note }, ...res.content.slice(1)] };
        }
      }
      return res;
    }
    if (!rider) return SETUP_RESULT;
    const { name } = req.params;
    const args = { ...(req.params.arguments || {}) };
    // Inject a default project when the caller omits it (Rider errors when multiple
    // projects are open and projectPath is missing).
    if (PROJECT_PATH && args.projectPath == null) args.projectPath = PROJECT_PATH;
    // Normalize Windows backslashes (see normalizeProjectPath) so Rider's file:// URI is valid.
    args.projectPath = normalizeProjectPath(args.projectPath);

    // A log-analysis call mis-routed to Rider: Rider's code index excludes Saved/ and isn't a log parser,
    // so it returns empty / "not a directory" / "doesn't exist". Steer it to gamedev-log regardless of
    // how Rider answered (hits, empty, or error) — append a one-line pointer to the first text part.
    // A log-analysis call mis-routed to Rider (args reference a log path) — steer to gamedev-log.
    const logSteer = looksLogTarget(args)
      ? "\n\n↪ This path looks like a LOG. Rider's code index excludes Saved/ (logs, build output) and " +
        "isn't a log parser, so log files aren't searchable/readable here. For log analysis use " +
        "gamedev-log (summary / search / locate / fields / diff) instead of rider."
      : "";
    // Append the gathered steer note(s) to the first text part of any result (hits / empty / error).
    const appendNote = (r, note) => {
      if (!note || !r || !Array.isArray(r.content)) return r;
      const c = r.content.slice();
      const i = c.findIndex((p) => p && p.type === "text" && typeof p.text === "string");
      if (i >= 0) c[i] = { ...c[i], text: c[i].text + note };
      else c.push({ type: "text", text: note.trimStart() });
      return { ...r, content: c };
    };
    // Single exit: whatever the result, append log + stale-project steers (the latter is computed from
    // the result, so it must run after the call). staleProjectNote fires only on a missing-but-on-disk path.
    const finish = (r) => appendNote(r, logSteer + staleProjectNote(r, args, PROJECT_PATH));

    let result;
    try {
      result = await rider.callTool({ name, arguments: args });
    } catch (e) {
      return finish({
        isError: true,
        content: [{ type: "text", text: `Rider MCP call '${name}' failed: ${e.message}` }],
      });
    }
    // Decide by response shape: only a list response (and one allowed by the optional restrict
    // filter) is summarized; everything else (file contents, status, …) passes through untouched.
    let info = parseSearch(result);
    if (!isSummarizable(name, info)) return finish(result);

    // Auto-escalate once: if the first fetch looks truncated, re-fetch with a larger
    // limit so the true count is known, then summarize with an accurate notice.
    // Only when the tool actually accepts a `limit` (learned from its schema).
    let meta = { escalated: false, fetchedLimit: Number(args.limit) || null };
    const callerLimit = Number(args.limit) || 0;
    const acceptsLimit = limitTools.size === 0 || limitTools.has(name);
    const looksTruncated = info.more || info.items.length > MAX_RESULTS;
    if (ESCALATE && acceptsLimit && looksTruncated && callerLimit < ESCALATE_LIMIT) {
      try {
        const big = await rider.callTool({
          name,
          arguments: { ...args, limit: ESCALATE_LIMIT },
        });
        if (parseSearch(big)) {
          result = big;
          meta = { escalated: true, fetchedLimit: ESCALATE_LIMIT };
        }
      } catch {
        /* keep the first result if the escalated call fails */
      }
    }
    return finish(summarize(result, { ...meta, name }));
  });

  await server.connect(new StdioServerTransport());
  log("ready on stdio (MAX_RESULTS=" + MAX_RESULTS + ").");
}

// Only auto-start when run as the entry point; importing this module (e.g. from tests) must not
// connect to Rider. The pure helpers above are exported for unit testing.
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => {
    log("fatal:", e);
    process.exit(1);
  });
}
