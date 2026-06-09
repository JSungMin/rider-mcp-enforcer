#!/usr/bin/env node
/*
 * ue-log-analyzer — standalone MCP server (no Rider, no IDE dependency).
 * Detects and analyzes editor logs (Unreal Saved/Logs, Unity Editor.log, or any
 * structured text log): parse → classify by severity/category → dedup spam →
 * search/filter, and a generic `log_fields` columnar extractor for trace logs.
 *
 * Pure file parsing. Settings: env var > ~/.ue-log-analyzer/config.json > default.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLogs, readText, analyzeLog, extractFields } from "./logs.js";

const CONFIG_DIR = path.join(os.homedir(), ".ue-log-analyzer");
const CONFIG_FILE = process.env.UELOG_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
} catch {
  /* no config yet */
}
function cfg(envName, key, def) {
  const e = process.env[envName];
  if (e !== undefined && e !== "") return e;
  const v = fileCfg[key];
  if (v !== undefined && v !== null && v !== "") return v;
  return def;
}
const PROJECT_PATH = cfg("UELOG_PROJECT_PATH", "projectPath", "");
const LOG_PATH = cfg("UELOG_PATH", "logPath", "");
const LOG_MAX_BYTES = parseInt(cfg("UELOG_MAX_BYTES", "logMaxBytes", "5000000"), 10) || 5000000;
const MAX_GROUPS = parseInt(cfg("UELOG_MAX_GROUPS", "maxGroups", "40"), 10) || 40;
const MAX_LINE_CHARS = parseInt(cfg("UELOG_MAX_LINE_CHARS", "maxLineChars", "200"), 10) || 200;
const CONFIG_KEYS = ["projectPath", "logPath", "logMaxBytes", "maxGroups", "maxLineChars"];

const log = (...a) => console.error("[ue-log-analyzer]", ...a);
const ok = (text, isError = false) => ({ isError, content: [{ type: "text", text }] });

function resolveLogPath(a) {
  if (a && a.path) return a.path;
  if (LOG_PATH) return LOG_PATH;
  return detectLogs((a && a.projectPath) || PROJECT_PATH)[0] || "";
}
function applySetup(args) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    /* new */
  }
  const changed = [];
  for (const k of CONFIG_KEYS)
    if (args[k] !== undefined) {
      current[k] = args[k];
      changed.push(k);
    }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  return { current, changed };
}

const TOOLS = [
  {
    name: "log_setup",
    description: "Configure ue-log-analyzer (projectPath, logPath, …). Writes ~/.ue-log-analyzer/config.json; run /reload-plugins after.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Project root (UE: finds <root>/Saved/Logs)" },
        logPath: { type: "string", description: "Explicit default log file" },
        logMaxBytes: { type: "number" },
        maxGroups: { type: "number" },
        maxLineChars: { type: "number" },
      },
    },
  },
  {
    name: "log_config",
    description: "Show current effective ue-log-analyzer settings + config-file path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_detect",
    description: "Find editor log files (Unreal Saved/Logs, Unity Editor.log) for the project, newest first.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" } } },
  },
  {
    name: "log_search",
    description:
      "Search/analyze an editor log: parse severity + category + file:line, dedup repeated spam into " +
      "templated groups with counts, severity-sorted + token-capped. Filters: query, severityMin, " +
      "category, file. groupBy 'template' (default) or 'callsite' (roll up by file:line).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        projectPath: { type: "string" },
        query: { type: "string" },
        severityMin: { type: "string", description: "Fatal|Error|Warning|Display (default Warning)" },
        category: { type: "string" },
        file: { type: "string" },
        maxGroups: { type: "number" },
        groupBy: { type: "string", description: "'template' or 'callsite'" },
      },
    },
  },
  {
    name: "log_fields",
    description:
      "Extract ONLY chosen scalar fields from structured trace-log lines into a compact table — the " +
      "biggest token win on dense per-frame logs. Field forms: `Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, " +
      "`ts`, `dts`, `d:Key`, `step:Key` (deltas vs previous row).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        projectPath: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        category: { type: "string" },
        file: { type: "string" },
        severityMin: { type: "string", description: "default Verbose (all)" },
        window: { type: "array", items: { type: "number" } },
        max: { type: "number" },
      },
      required: ["fields"],
    },
  },
  {
    name: "log_summary",
    description: "Overview of an editor log: counts per severity + top categories. No message bodies.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, projectPath: { type: "string" } } },
  },
  {
    name: "log_tail",
    description: "Last N raw lines of a log (escape hatch).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, projectPath: { type: "string" }, lines: { type: "number" } },
    },
  },
];

const server = new Server({ name: "ue-log", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const a = req.params.arguments || {};
  try {
    if (name === "log_setup") {
      const { current, changed } = applySetup(a);
      return ok(
        (changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys; nothing changed.") +
          `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}\n\nRun /reload-plugins to apply.`
      );
    }
    if (name === "log_config") {
      return ok(
        `Effective settings (env > config > default):\n` +
          JSON.stringify({ projectPath: PROJECT_PATH || "(unset)", logPath: LOG_PATH || "(auto)", logMaxBytes: LOG_MAX_BYTES, maxGroups: MAX_GROUPS, maxLineChars: MAX_LINE_CHARS }, null, 2) +
          `\n\nConfig file: ${CONFIG_FILE}`
      );
    }
    if (name === "log_detect") {
      const found = detectLogs(a.projectPath || PROJECT_PATH);
      return ok(
        found.length
          ? `Editor logs (newest first):\n${found.map((p) => "  " + p).join("\n")}\nUse log_search { "path": "${found[0]}" }.`
          : `No editor logs found. Pass a path, set logPath, or projectPath (looked under <project>/Saved/Logs and Unity Editor.log).`
      );
    }
    const lp = resolveLogPath(a);
    if (!lp) return ok("No log path. Pass path/projectPath or run log_detect.", true);
    if (!fs.existsSync(lp)) return ok(`Log not found: ${lp}`, true);

    if (name === "log_tail") {
      const n = Number(a.lines) || 80;
      const tail = readText(lp, LOG_MAX_BYTES).split(/\r?\n/).slice(-n)
        .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + " …" : l));
      return ok(`Last ${tail.length} line(s) of ${lp}:\n` + tail.join("\n"));
    }
    const text = readText(lp, LOG_MAX_BYTES);
    if (name === "log_fields") {
      return ok(
        `Source: ${lp}\n` +
          extractFields(text, {
            fields: Array.isArray(a.fields) && a.fields.length ? a.fields : ["ts"],
            query: a.query || "",
            category: a.category || "",
            file: a.file || "",
            severityMin: a.severityMin || "Verbose",
            window: Array.isArray(a.window) && a.window.length === 2 ? a.window : null,
            max: Number(a.max) || 200,
            maxLineChars: MAX_LINE_CHARS,
          })
      );
    }
    return ok(
      `Source: ${lp}\n` +
        analyzeLog(text, {
          query: a.query || "",
          severityMin: a.severityMin || "Warning",
          category: a.category || "",
          file: a.file || "",
          maxGroups: Number(a.maxGroups) || MAX_GROUPS,
          maxLineChars: MAX_LINE_CHARS,
          summaryOnly: name === "log_summary",
          groupBy: a.groupBy === "callsite" ? "callsite" : "template",
        })
    );
  } catch (e) {
    return ok(`log tool error: ${e.message}`, true);
  }
});

await server.connect(new StdioServerTransport());
log("ready on stdio.");
