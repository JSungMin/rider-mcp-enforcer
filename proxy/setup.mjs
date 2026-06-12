#!/usr/bin/env node
/*
 * rider-mcp-enforcer setup CLI — write the plugin config file (no Rider needed).
 *
 *   node setup.mjs --show
 *   node setup.mjs --detect
 *   node setup.mjs riderSseUrl=http://127.0.0.1:64342/sse projectPath="G:/Path/To/Project"
 *   node setup.mjs exclude="/intermediate/,/binaries/,.vcxproj" maxResults=80
 *
 * Settings are read by the proxy at startup → run /reload-plugins (or restart) to apply.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE =
  process.env.RIDER_CONFIG_FILE ||
  path.join(os.homedir(), ".rider-mcp-enforcer", "config.json");
const KEYS = [
  "riderSseUrl", "projectPath", "maxResults", "escalate", "escalateLimit",
  "maxLineChars", "exclude", "excludeOff", "summarizeTools", "statsFile",
  "regenCmd", "enginePath", "regenTimeout", "excludeCommands", "lang",
];
const NUM = new Set(["maxResults", "escalateLimit", "maxLineChars", "regenTimeout"]);
const BOOL = new Set(["escalate", "excludeOff"]);

const read = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; }
};
const args = process.argv.slice(2);

if (args.includes("--show")) {
  console.log(`Config file: ${CONFIG_FILE}`);
  console.log(JSON.stringify(read(), null, 2));
  process.exit(0);
}

if (args.includes("--detect")) {
  const cands = ["http://127.0.0.1:64342/sse", "http://127.0.0.1:63342/sse"];
  const found = [];
  for (const url of cands) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 1500);
      const r = await fetch(url, { signal: ac.signal });
      clearTimeout(to);
      if (r.status >= 200 && r.status < 400) found.push(url);
    } catch { /* not listening */ }
  }
  console.log(found.length
    ? `Found Rider MCP SSE: ${found.join(", ")}\nApply: node setup.mjs riderSseUrl=${found[0]}`
    : `No Rider MCP SSE on 63342/64342. Enable it in Rider (Settings | Tools | MCP Server) and use Copy SSE Config.`);
  process.exit(0);
}

const cfg = read();
const changed = [];
for (const a of args) {
  const i = a.indexOf("=");
  if (i < 0) continue;
  const k = a.slice(0, i);
  let v = a.slice(i + 1);
  if (!KEYS.includes(k)) { console.error(`(skip unknown key: ${k})`); continue; }
  if (NUM.has(k)) v = Number(v);
  else if (BOOL.has(k)) v = ["1", "true", "on", "yes"].includes(String(v).toLowerCase());
  cfg[k] = v;
  changed.push(k);
}
if (!changed.length) {
  console.log("Nothing to change. Use --show, --detect, or key=value pairs.");
  process.exit(0);
}
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
console.log(`Updated ${changed.join(", ")} → ${CONFIG_FILE}`);
console.log(`Run /reload-plugins (or restart Claude Code) to apply.`);
