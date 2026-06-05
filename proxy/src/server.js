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
// Compact each item to `path:line  lineText`, cap at MAX_RESULTS, surface truncation/`more`.
function summarize(result) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = result.content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    let parsed;
    try {
      parsed = JSON.parse(part.text);
    } catch {
      return summarizeLines(part);
    }
    const items = Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed)
      ? parsed
      : null;
    if (!items) return summarizeLines(part);
    const kept = items.slice(0, MAX_RESULTS).map((it) => {
      const p = String(it.filePath ?? it.path ?? it.pathInProject ?? "").replace(/\\/g, "/");
      const line = it.startLine ?? it.line ?? "";
      const txt = String(it.lineText ?? it.text ?? "").trim();
      return `${p}${line !== "" ? ":" + line : ""}${txt ? "  " + txt : ""}`;
    });
    let text = kept.join("\n");
    const extra = items.length - kept.length;
    if (extra > 0) text += `\n… ${extra} more truncated by rider-search-proxy (raise RIDER_MAX_RESULTS or narrow q).`;
    if (parsed?.more) text += `\n(server reports more results available — narrow q or raise the tool's limit.)`;
    return { type: "text", text: text || part.text };
  });
  return { ...result, content };
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
    return SUMMARIZE.has(name) ? summarize(result) : result;
  });

  await server.connect(new StdioServerTransport());
  log("ready on stdio (MAX_RESULTS=" + MAX_RESULTS + ").");
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
