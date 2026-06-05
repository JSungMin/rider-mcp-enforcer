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
const SUMMARIZE = new Set(
  (
    process.env.RIDER_SUMMARIZE_TOOLS ||
    "find_references,find_symbol,find_usages,list_file_symbols,search_in_files_content"
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

// Reduce a tool result's text content to <= MAX_RESULTS ref-like lines + a footer.
function summarize(result) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = result.content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const lines = part.text.split(/\r?\n/);
    const refLike = lines.filter(
      (l) => /\.[A-Za-z0-9_]+[:(]\s*\d+/.test(l) || /:\d+:/.test(l)
    );
    const base = refLike.length ? refLike : lines.filter((l) => l.trim().length);
    const kept = base.slice(0, MAX_RESULTS).map((l) => l.trim());
    let text = kept.join("\n");
    const extra = base.length - kept.length;
    if (extra > 0) {
      text +=
        `\n… ${extra} more result(s) truncated by rider-search-proxy ` +
        `(raise RIDER_MAX_RESULTS or narrow the query).`;
    }
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
    const { name, arguments: args } = req.params;
    let result;
    try {
      result = await rider.callTool({ name, arguments: args || {} });
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
