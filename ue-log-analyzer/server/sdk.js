// Resolve the MCP SDK from the plugin data dir (node_modules auto-installed there by the
// SessionStart hook) when running as an installed plugin, else from local node_modules (dev).
// ESM ignores NODE_PATH, and the SDK remaps subpaths via "exports", so installed-mode
// resolution uses createRequire (which honours "exports") anchored in the data dir.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DATA = process.env.CLAUDE_PLUGIN_DATA;
let load;
if (DATA) {
  const req = createRequire(pathToFileURL(path.join(DATA, "package.json")).href);
  load = (sub) => import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/" + sub)).href);
} else {
  load = (sub) => import("@modelcontextprotocol/sdk/" + sub);
}

export const { Server } = await load("server/index.js");
export const { StdioServerTransport } = await load("server/stdio.js");
export const { ListToolsRequestSchema, CallToolRequestSchema } = await load("types.js");
