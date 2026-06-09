---
description: Configure the rider-mcp-enforcer plugin (Rider SSE URL, project path, result caps, exclude filter, etc.). Use when the user runs /rider-mcp-enforcer:setup or asks to set up / configure the Rider plugin or its environment variables.
disable-model-invocation: true
---

# Rider plugin — setup

Configure the plugin by writing its config file (`~/.rider-mcp-enforcer/config.json`), read by the
proxy at startup. Do this entirely through the `rider-search` MCP tools — do NOT edit the user's OS
environment variables.

## Steps
1. **Detect the Rider endpoint:** call `rider_detect`. If it finds an SSE URL, propose it. If not,
   tell the user to enable Rider MCP (Settings | Tools | MCP Server → Enable → Copy SSE Config) and
   paste the URL.
2. **Show current settings:** call `rider_config` so the user sees what's set.
3. **Gather the values to change.** Ask the user (one question at a time, or an `AskUserQuestion` with
   the common ones). Typical keys:
   - `riderSseUrl` — Rider MCP SSE URL (required for search to work)
   - `projectPath` — default project root (needed when multiple projects are open in Rider)
   - `exclude` — comma list of path substrings to drop (default already covers build artifacts)
   - `excludeOff` — true to keep build-artifact paths
   - `maxResults`, `escalateLimit`, `maxLineChars` — token/limit tuning
   - `summarizeTools` — which Rider tools to summarize
4. **Apply:** call `rider_setup` with only the keys to change, e.g.
   `rider_setup { "riderSseUrl": "http://127.0.0.1:64342/sse", "projectPath": "G:/Path/To/Project" }`.
5. **Tell the user to run `/reload-plugins`** (or restart Claude Code) — settings are read at proxy
   startup, so they don't take effect until reload.

## Notes
- Precedence is **environment variable > config file > default**. If a setting won't change, an env
  var of the same name may be overriding it (`RIDER_MCP_SSE_URL`, `RIDER_PROJECT_PATH`, …).
- Shell alternative (no Claude): `node "${CLAUDE_PLUGIN_ROOT}/proxy/setup.mjs" --detect` then
  `node "${CLAUDE_PLUGIN_ROOT}/proxy/setup.mjs" riderSseUrl=... projectPath=...`.
- Never write internal project paths or symbol names into any public/shared location.
