#!/usr/bin/env node
/*
 * rider-search-proxy
 * ------------------
 * An MCP server (stdio, for Claude Code) that is also an MCP client (SSE) to
 * JetBrains Rider's built-in MCP server. It forwards every tool call to Rider,
 * but SUMMARIZES the responses of high-fan-out search tools (find_references,
 * find_symbol, ...) down to `file:line` lines and caps the count, so a
 * find-usages flood on a large Unreal C++ codebase cannot blow up the context.
 *
 * Config (env):
 *   RIDER_MCP_SSE_URL     Rider MCP SSE URL. Rider -> Settings | Tools | MCP Server
 *                         -> Enable -> "Copy SSE Config". Required.
 *   RIDER_MAX_RESULTS     Max lines kept per summarized response (default 50).
 *   RIDER_SUMMARIZE_TOOLS Comma list of Rider tool names to summarize
 *                         (default: find_references,find_symbol,find_usages,
 *                          list_file_symbols,search_in_files_content).
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
const SUMMARIZE = new Set(
  String(
    cfg(
      "RIDER_SUMMARIZE_TOOLS",
      "summarizeTools",
      "search_symbol,search_file,search_text,search_regex,search_in_files_by_text,search_in_files_by_regex,find_files_by_name_keyword,find_files_by_glob"
    )
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const log = (...a) => console.error("[rider-search-proxy]", ...a);

// ---- setup / config (written by the setup command, read at proxy startup) ----
const CONFIG_KEYS = [
  "riderSseUrl", "projectPath", "maxResults", "escalate", "escalateLimit",
  "maxLineChars", "exclude", "excludeOff", "summarizeTools", "statsFile",
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
async function detectRiderUrl() {
  const candidates = [
    "http://127.0.0.1:64342/sse",
    "http://127.0.0.1:63342/sse",
  ];
  const found = [];
  for (const url of candidates) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 1500);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(to);
      if (res.status >= 200 && res.status < 400) found.push(url);
    } catch {
      /* not listening */
    }
  }
  return found;
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

function isExcluded(p) {
  if (EXCLUDE_OFF) return false;
  const lp = p.toLowerCase();
  return EXCLUDE.some((x) => lp.includes(x));
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
function summarizeLines(part) {
  const lines = part.text.split(/\r?\n/).filter((l) => l.trim().length);
  const kept = lines.slice(0, MAX_RESULTS).map((l) => l.trim());
  let text = kept.join("\n");
  const extra = lines.length - kept.length;
  if (extra > 0) text += `\n… ${extra} more line(s) truncated by rider-search-proxy.`;
  return { type: "text", text: text || part.text };
}

// Rider search/symbol tools return JSON: {"items":[{filePath,startLine,lineText,...}],"more":bool}.
// Extract {items, more} from the first JSON text part, or null if not that shape.
function parseSearch(result) {
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

function itemLine(it) {
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
function summarizeSearch(info, { escalated, fetchedLimit }) {
  const kept0 = info.items.filter(
    (it) => !isExcluded(String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/"))
  );
  const excluded = info.items.length - kept0.length;
  const shown = Math.min(kept0.length, MAX_RESULTS);
  const hidden = kept0.length - shown;
  const incomplete = hidden > 0 || info.more;
  const lines = kept0.slice(0, MAX_RESULTS).map(itemLine);
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
function summarize(result, meta = {}) {
  const info = parseSearch(result);
  if (!info) {
    // not the items-JSON shape → fall back to line trimming on text parts
    if (!result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: result.content.map((p) =>
        p.type === "text" && typeof p.text === "string" ? summarizeLines(p) : p
      ),
    };
  }
  const { text, excluded } = summarizeSearch(info, meta);
  const rawTok = tok((result.content || []).map((p) => p.text || "").join("\n"));
  recordSavings(rawTok, tok(text), excluded);
  return { ...result, content: [{ type: "text", text }] };
}

const SETUP_RESULT = {
  isError: true,
  content: [
    {
      type: "text",
      text:
        "rider-search-proxy is not connected to Rider. In Rider: Settings | Tools | MCP Server " +
        "-> Enable MCP Server -> Copy SSE Config, set RIDER_MCP_SSE_URL to that URL, then restart " +
        "Claude Code. Until then, fall back to grep for this turn.",
    },
  ],
};

async function main() {
  let rider = await connectRider().catch((e) => {
    log("Rider connect failed:", e.message);
    return null;
  });

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
    return {
      tools: [
        ...SAVINGS_TOOLS,
        ...tools.map((t) => ({
          ...t,
          description:
            (SUMMARIZE.has(t.name)
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
    if (req.params.name === "rider_detect") {
      const found = await detectRiderUrl();
      return {
        content: [
          {
            type: "text",
            text: found.length
              ? `Found Rider MCP SSE at:\n${found.map((u) => "  " + u).join("\n")}\n` +
                `Set it with rider_setup { "riderSseUrl": "${found[0]}" }, then /reload-plugins.\n` +
                `(Verify in Rider: Settings | Tools | MCP Server → Copy SSE Config — the port is per-instance.)`
              : `No Rider MCP SSE endpoint responded on the common ports (63342/64342). ` +
                `Enable it in Rider (Settings | Tools | MCP Server → Enable), then use Copy SSE Config ` +
                `and set riderSseUrl via rider_setup.`,
          },
        ],
      };
    }
    if (req.params.name === "rider_savings") {
      return { content: [{ type: "text", text: savingsReport() }] };
    }
    if (req.params.name === "rider_savings_reset") {
      writeStats({ calls: 0, rawTokens: 0, sentTokens: 0, excludedItems: 0, since: new Date().toISOString() });
      return { content: [{ type: "text", text: "rider-mcp-enforcer savings ledger reset." }] };
    }
    if (!rider) return SETUP_RESULT;
    const { name } = req.params;
    const args = { ...(req.params.arguments || {}) };
    // Inject a default project when the caller omits it (Rider errors when multiple
    // projects are open and projectPath is missing).
    if (PROJECT_PATH && args.projectPath == null) args.projectPath = PROJECT_PATH;
    let result;
    try {
      result = await rider.callTool({ name, arguments: args });
    } catch (e) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Rider MCP call '${name}' failed: ${e.message}` },
        ],
      };
    }
    if (!SUMMARIZE.has(name)) return result;

    // Auto-escalate once: if the first fetch looks truncated, re-fetch with a larger
    // limit so the true count is known, then summarize with an accurate notice.
    let meta = { escalated: false, fetchedLimit: Number(args.limit) || null };
    const info = parseSearch(result);
    const callerLimit = Number(args.limit) || 0;
    const looksTruncated =
      info && (info.more || info.items.length > MAX_RESULTS);
    if (ESCALATE && looksTruncated && callerLimit < ESCALATE_LIMIT) {
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
    return summarize(result, meta);
  });

  await server.connect(new StdioServerTransport());
  log("ready on stdio (MAX_RESULTS=" + MAX_RESULTS + ").");
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
