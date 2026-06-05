# rider-mcp-enforcer

A **Claude Code plugin** that makes Claude do symbol search, find-usages, file search, and
function/variable navigation through **JetBrains Rider's live index** instead of Bash `grep` —
and *enforces* it, while capping the tokens a find-usages flood can spend.

Built for large **Unreal C++ (Rider for Unreal)** and **.NET/C#** codebases, where `grep` is slow
and burns context.

## What it does

Rider 2025.2+ ships an MCP server that already exposes `find_symbol`, `find_references`,
`list_file_symbols`, `get_symbol_info`, `rename_refactoring`. This plugin adds the layer that
makes Claude actually use it:

| Layer | File | Effect |
| --- | --- | --- |
| **Enforcement hook** | `hooks/block-code-grep.js` | Blocks Bash `grep`/`rg`/`find -name` over source files and redirects Claude to the Rider MCP tools. Non-code text searches (logs, md, json) pass through. |
| **Routing skill** | `skills/rider-search/SKILL.md` | Karpathy-style rules: symbol/ref/file lookups → Rider tools first; grep is last resort. |
| **Summarizing proxy** | `proxy/` | An MCP server that fronts Rider's MCP and trims `find_references`/`find_symbol` responses to `file:line` lines, capped at `RIDER_MAX_RESULTS`. Stops UE find-usages floods from blowing up context. |

> Honest scope: Rider's MCP alone already gives you symbol search. This plugin's value is
> **enforcement + token control** on top of it.

## Prerequisites

- **JetBrains Rider 2025.2+**, running, with the project open.
- **Node.js ≥ 18** on PATH.
- Rider MCP enabled: **Settings | Tools | MCP Server → Enable MCP Server**, then **Copy SSE Config**.

## Install

```bash
# 1) Add this repo as a Claude Code plugin marketplace and install
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer

# 2) Install the proxy's dependencies (one time)
cd <plugin-dir>/proxy && npm install
#   <plugin-dir> is where Claude Code cloned the plugin; see /plugin for the path.

# 3) Point the proxy at Rider's MCP SSE URL (from "Copy SSE Config")
#    e.g. export it in your shell / environment before launching Claude Code:
export RIDER_MCP_SSE_URL="http://localhost:<port>/sse"     # macOS/Linux
$env:RIDER_MCP_SSE_URL = "http://localhost:<port>/sse"     # PowerShell
```

Restart Claude Code (or `/reload-plugins`). Verify the `rider-search` MCP server and its tools
appear, and that a `grep src/**/*.cpp` is blocked with a redirect message.

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `RIDER_MCP_SSE_URL` | — (required) | Rider MCP SSE URL from "Copy SSE Config". Without it the proxy returns setup instructions and Claude falls back to grep. |
| `RIDER_MAX_RESULTS` | `50` | Max `file:line` lines kept per summarized response. |
| `RIDER_SUMMARIZE_TOOLS` | `find_references,find_symbol,find_usages,list_file_symbols,search_in_files_content` | Which Rider tool responses to summarize. |
| `RIDER_ENFORCE` | `1` | Set to `0`/`false`/`off` to **disable the grep-blocking hook** — use this if Rider MCP is off/unavailable and you don't want code searches blocked. |

## How enforcement works

- The **hook** runs before every Bash call. If the command is a code-symbol search (grep/rg/ack/ag/
  findstr or `find -name` targeting `*.cpp/.h/.cs/...` or `src|source|engine|plugins/`) and is *not*
  aimed at a log/md/json/build path, it exits non-zero and Claude sees a message telling it to use
  the Rider tool. Otherwise it allows the command.
- The **skill** biases Claude toward the Rider tools proactively.
- The **proxy** guarantees the token cap regardless of how Claude calls the tool.

## Enable Rider MCP (do this first — it is OFF until you enable it)

The Rider MCP server is **not active by default in every build/setup** — many users have it disabled
and see the plugin "do nothing useful." Enable and locate it:

1. Rider → **Settings | Tools | MCP Server**.
2. Tick **Enable MCP Server**. (If you don't see this page, update to Rider **2025.2+**.)
3. In **Manual Client Configuration**, click **Copy SSE Config** (or Copy Stdio Config).
4. From the copied config, take the SSE URL and set it:
   ```bash
   export RIDER_MCP_SSE_URL="http://localhost:<port>/sse"   # macOS/Linux
   $env:RIDER_MCP_SSE_URL = "http://localhost:<port>/sse"   # PowerShell
   ```
   The port is **per-instance** (often in the 63342/64342 range, but do not hardcode — copy it).
5. Restart Claude Code (or `/reload-plugins`).

### Verify it's actually on
```bash
# Is Rider serving the MCP SSE endpoint? 200/SSE = good, connection refused = disabled/wrong port.
curl -i -m 3 "$RIDER_MCP_SSE_URL"
```
In Claude Code, the `rider-search` server should list real Rider tools (`find_symbol`,
`find_references`, …). If it only lists a single `rider_status` tool, the proxy could **not** reach
Rider — MCP is off or the URL is wrong.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `rider-search` only shows a `rider_status` tool | Proxy can't reach Rider (MCP disabled or wrong URL) | Enable MCP (above), set/correct `RIDER_MCP_SSE_URL`, restart. |
| Tool call returns "rider-search-proxy is not connected to Rider" | `RIDER_MCP_SSE_URL` unset/unreachable | Set it from **Copy SSE Config**; confirm with `curl`. |
| **Code searches get blocked but Rider tools don't work** (MCP off → stuck) | Hook blocks grep while Rider is unavailable | Set `RIDER_ENFORCE=0` to disable the block until MCP is on, **or** disable the plugin. |
| Hook blocks a search you wanted | False positive on a code path | Target a non-code file, or set `RIDER_ENFORCE=0` for that session. |
| Wrong/empty summaries | Rider tool name differs from defaults, or unusual response shape | Set `RIDER_SUMMARIZE_TOOLS` to your build's tool names; tune `RIDER_MAX_RESULTS`. |
| `curl` to the SSE URL refuses connection | Rider not running, MCP off, or wrong port | Start Rider, enable MCP, re-copy the SSE config. |

> **The disabled-MCP footgun:** with MCP off, the proxy returns "not connected" *and* the hook would
> block code-grep — leaving Claude no way to search. The hook honors `RIDER_ENFORCE=0` precisely for
> this case: it disables blocking so grep works as a fallback until you turn MCP on.

## Status / caveats

- **v0.1.x, pre-live-verification of the Rider tool schema.** Tool names target Rider 2025.2+. If your
  build names a tool differently, check the `rider-search` tool list and set `RIDER_SUMMARIZE_TOOLS`.
- The summarizer is heuristic (keeps `path:line`-looking lines). Tune `RIDER_MAX_RESULTS` per repo.
- Transport is SSE. If your Rider build only offers stdio, open an issue — a stdio client mode can be
  added.

## License

MIT © 2026 JSungMin
