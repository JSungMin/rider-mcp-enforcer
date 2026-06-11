#!/usr/bin/env node
/*
 * rider-mcp-enforcer regen CLI — regenerate Unreal project files so Rider re-indexes after source files
 * were added/moved/renamed. This is the SAME engine as the `rider_regen_project` MCP tool, but run by YOU
 * directly — so it needs NO "allow MCP shell access" approval prompt. Use it when you'd rather not grant
 * the MCP tool shell permission.
 *
 *   node regen.mjs                 # DRY RUN — resolve + print the .uproject, engine, and exact command
 *   node regen.mjs --confirm       # actually run the regen
 *   node regen.mjs --project="G:/Path/To/Proj" --confirm
 *   node regen.mjs --force --confirm   # ignore a stale regen lock
 *
 * Reads the same config as the proxy (env > ~/.rider-mcp-enforcer/config.json > defaults):
 *   RIDER_PROJECT_PATH / projectPath, RIDER_REGEN_CMD / regenCmd, RIDER_ENGINE_PATH / enginePath,
 *   RIDER_REGEN_TIMEOUT / regenTimeout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { regenProject } from "./src/regen.mjs";

const CONFIG_FILE = process.env.RIDER_CONFIG_FILE || path.join(os.homedir(), ".rider-mcp-enforcer", "config.json");
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
} catch {
  /* no config file — env + defaults */
}
const cfg = (env, key, def = "") => {
  const e = process.env[env];
  if (e !== undefined && e !== "") return e;
  const v = fileCfg[key];
  return v !== undefined && v !== null && v !== "" ? v : def;
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const projArg = (argv.find((a) => a.startsWith("--project=")) || "").split("=").slice(1).join("=");

const result = regenProject(
  { confirm: has("--confirm"), force: has("--force"), ...(projArg ? { projectPath: projArg } : {}) },
  {
    projectPath: cfg("RIDER_PROJECT_PATH", "projectPath"),
    configDir: path.dirname(CONFIG_FILE),
    regenCmd: cfg("RIDER_REGEN_CMD", "regenCmd"),
    engineOverride: cfg("RIDER_ENGINE_PATH", "enginePath"),
    timeoutMs: parseInt(cfg("RIDER_REGEN_TIMEOUT", "regenTimeout", "300000"), 10) || 300000,
  }
);

console.log((result.content && result.content[0] && result.content[0].text) || "(no output)");
if (!has("--confirm") && !result.isError) {
  console.log("\n(dry run — nothing was executed. Re-run with --confirm to regenerate.)");
}
process.exit(result.isError ? 1 : 0);
