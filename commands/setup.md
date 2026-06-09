---
description: Configure the rider-mcp-enforcer plugin (Rider SSE URL, project path, result caps, exclude filter). Writes ~/.rider-mcp-enforcer/config.json and tells you to /reload-plugins.
---

# Rider plugin — setup

Configure the plugin by writing its config file (`~/.rider-mcp-enforcer/config.json`), which the
proxy reads at startup. Use the `rider-search` MCP tools — do NOT edit the user's OS environment.

Steps:
1. **Detect the Rider endpoint:** call the `rider_detect` tool. If it finds an SSE URL, propose it.
   If not, tell the user to enable Rider MCP (Rider → Settings | Tools | MCP Server → Enable → Copy
   SSE Config) and paste the URL.
2. **Show current settings:** call `rider_config`.
3. **Gather values** (ask one at a time, or an `AskUserQuestion` for the common ones):
   - `riderSseUrl` — Rider MCP SSE URL (required for search)
   - `projectPath` — default project root (needed when multiple projects are open in Rider)
   - `exclude` — comma list of path substrings to drop (default already covers build artifacts)
   - `excludeOff`, `maxResults`, `escalateLimit`, `maxLineChars`, `summarizeTools` — optional tuning
4. **Apply:** call `rider_setup` with only the keys to change, e.g.
   `rider_setup { "riderSseUrl": "http://127.0.0.1:64342/sse", "projectPath": "<project root>" }`.
5. **Tell the user to run `/reload-plugins`** (or restart) — settings are read at proxy startup.

Notes:
- Precedence is **environment variable > config file > default**; a same-named env var still wins.
- Shell alternative: `node "${CLAUDE_PLUGIN_ROOT}/proxy/setup.mjs" --detect`, then
  `node "${CLAUDE_PLUGIN_ROOT}/proxy/setup.mjs" riderSseUrl=... projectPath=...`.
- If the `rider-search` tools are absent, the plugin's MCP server isn't running — check that
  `cd <plugin-dir>/proxy && npm install` was done, then `/reload-plugins`.
- Never write internal project paths or symbol names into any public/shared location.

$ARGUMENTS
