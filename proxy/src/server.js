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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RIDER_URL = process.env.RIDER_MCP_SSE_URL || "";
const MAX_RESULTS = parseInt(process.env.RIDER_MAX_RESULTS || "50", 10) || 50;
// Default project for Rider tools when multiple projects are open and the caller
// omits projectPath (Rider errors out otherwise). Optional.
const PROJECT_PATH = process.env.RIDER_PROJECT_PATH || "";
// On truncation, auto-retry once with a bigger limit to learn the true count, then
// loudly flag incompleteness so Claude asks the user instead of coding on a partial set.
const ESCALATE = !["0", "false", "off"].includes(
  String(process.env.RIDER_ESCALATE ?? "1").toLowerCase()
);
const ESCALATE_LIMIT = parseInt(process.env.RIDER_ESCALATE_LIMIT || "500", 10) || 500;
// Cap each result's code snippet so one giant line (e.g. a long generated build-file line)
// cannot blow the token budget.
const MAX_LINE_CHARS = parseInt(process.env.RIDER_MAX_LINE_CHARS || "200", 10) || 200;
// Real Rider MCP (2025.2+) search/symbol tools whose JSON responses we compact.
const SUMMARIZE = new Set(
  (
    process.env.RIDER_SUMMARIZE_TOOLS ||
    "search_symbol,search_file,search_text,search_regex,search_in_files_by_text,search_in_files_by_regex,find_files_by_name_keyword,find_files_by_glob"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const log = (...a) => console.error("[rider-search-proxy]", ...a);

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
  const shown = Math.min(info.items.length, MAX_RESULTS);
  const hidden = info.items.length - shown;
  const incomplete = hidden > 0 || info.more;
  const lines = info.items.slice(0, MAX_RESULTS).map(itemLine);
  let text = lines.join("\n");
  if (incomplete) {
    const total = info.more ? `${info.items.length}+` : `${info.items.length}`;
    const banner =
      `\n\n⚠ INCOMPLETE RESULTS — showing ${shown} of ${total} match(es)` +
      (escalated ? ` (proxy already auto-raised the limit to ${fetchedLimit})` : "") +
      `.\nThis list is NOT exhaustive. Do NOT use it as the complete set for finding all` +
      ` references, refactoring, or renaming — you may miss call sites and write wrong code.\n` +
      `Ask the USER to choose one:\n` +
      `  1) raise the cap (set RIDER_MAX_RESULTS higher, or pass a larger \`limit\`) to see all,\n` +
      `  2) narrow the search (pass \`paths\` to a subdirectory), or\n` +
      `  3) explicitly confirm a partial/representative result is acceptable for this task.`;
    text += banner;
  }
  return text || "(no results)";
}

// Public entry: summarize a (possibly escalated) result for a search tool.
function summarize(result, meta = {}) {
  const info = parseSearch(result);
  if (!info) {
    // not the items-JSON shape → fall back to line trimming on text parts
    if (!result || !Array.isArray(result.content)) return result;
    return { ...result, content: result.content.map((p) =>
      p.type === "text" && typeof p.text === "string" ? summarizeLines(p) : p) };
  }
  return { ...result, content: [{ type: "text", text: summarizeSearch(info, meta) }] };
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!rider) {
      return {
        tools: [
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
      tools: tools.map((t) => ({
        ...t,
        description:
          (SUMMARIZE.has(t.name)
            ? "[PREFERRED over Bash grep — Rider live index, summarized & token-capped] "
            : "") + (t.description || ""),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
