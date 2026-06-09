# rider-mcp-enforcer

A **Claude Code plugin** that makes Claude do symbol search, find-usages, file search, and
function/variable navigation through **JetBrains Rider's live index** instead of Bash `grep` —
and *enforces* it, while capping the tokens a find-usages flood can spend.

Built for large **Unreal C++ (Rider for Unreal)** and **.NET/C#** codebases, where `grep` is slow
and burns context.

## What it does

Rider 2025.2+ ships an MCP server that exposes (verified live) `search_symbol`, `search_file`,
`search_text`, `search_regex`, `find_files_by_name_keyword`, `find_files_by_glob`, `get_symbol_info`,
`rename_refactoring`, `read_file`, and ~20 more. This plugin adds the layer that makes Claude
actually use them instead of grep:

| Layer | File | Effect |
| --- | --- | --- |
| **Enforcement hook** | `hooks/block-code-grep.js` | Blocks Bash `grep`/`rg`/`find -name` over source files and redirects Claude to the Rider MCP tools. Non-code text searches (logs, md, json) pass through. Set `RIDER_ENFORCE=0` to disable. |
| **Routing skill** | `skills/rider-search/SKILL.md` | Karpathy-style rules: symbol/file/text lookups → Rider tools first; grep is last resort. |
| **Summarizing proxy** | `proxy/` | An MCP server fronting Rider's MCP. Parses the JSON search responses (`{items:[{filePath,startLine,lineText}],more}`) into compact `path:line  text`, capped at `RIDER_MAX_RESULTS`, and injects a default `projectPath`. Stops large-codebase result floods from blowing up context. |

> Honest scope: Rider's MCP alone already gives you symbol/file search. This plugin's value is
> **enforcement + token control + projectPath ergonomics** on top of it.
>
> **Two real limitations of this Rider MCP build (verified live):**
> 1. **No semantic find-usages/find-references tool.** Reference-finding falls back to `search_text`/
>    `search_regex` (indexed string match, not semantic).
> 2. **`search_symbol` on Unreal C++ can be weak** — it may return filename/path matches (e.g. `.Build.cs`)
>    rather than the exact class. Verify results; fall back to `search_text` when a symbol hit looks off.

## Performance (measured)

Real A/B on a large UE5 project — finding one class name (~2,400 textual occurrences) via Bash grep
vs this plugin. No project source is reproduced; see [BENCHMARK.md](BENCHMARK.md) for method.

| | Bash grep (whole repo) | Bash grep (game dir) | **Plugin (Rider MCP, summarized)** |
| --- | ---: | ---: | ---: |
| Tokens to the model | ~195,600 | ~114,100 | **~1,700** |
| Wall time | 55,006 ms | 382 ms | **~870 ms** |

- **Tokens: ~98–99% fewer (~67–115×)** — always. ~87% from response summarization, the rest from capping.
- **Time: ~63× faster** when grep would scan the whole repo (incl. Engine); slightly slower than a
  pre-narrowed grep (MCP has fixed SSE round-trip overhead, ripgrep is very fast on a small scope).

### Accuracy difference (and why)
It's a **precision/recall trade**, not "one is more correct":
- **Recall:** the plugin returns the top `N` (cap), not all 2,400+ hits. The withheld ~98% are mostly
  comments/includes/substring noise. Need an exhaustive list? Raise `RIDER_MAX_RESULTS` or use grep.
- **Precision:** grep matches every substring (a `Foo` query also hits `FooBar`), over-reporting ~100×
  here; the plugin's symbol search returned 25 distinct candidate files.
- **Known weakness:** on Unreal C++, `search_symbol` may point at a file's line 1 rather than the exact
  declaration (Rider indexing limit). `search_text` gives the real `file:line  code`; the skill tells
  Claude to prefer it when a symbol hit looks off.

> Net: for navigation (definition + representative usages) the plugin is more accurate **and** far
> cheaper; for an exhaustive occurrence audit, raise the cap or use grep on purpose.

### Incomplete results (correctness guard)
Capping is good for tokens but dangerous for "find ALL references" — a missed call site means wrong
code. So truncation is **never silent**:

1. When the first fetch looks truncated, the proxy **auto-retries once** with a larger limit
   (`RIDER_ESCALATE_LIMIT`) to learn the true count.
2. If the set is still not exhaustive, the response carries a loud `⚠ INCOMPLETE RESULTS — showing X
   of Y+` banner with three options: **raise the cap**, **narrow scope (`paths`)**, or **confirm a
   partial set is acceptable**.
3. The skill instructs Claude: for references/refactor/rename, **stop and ask the user** with those
   options instead of acting on the partial list.

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
| `RIDER_PROJECT_PATH` | — | Default project path the proxy injects when a tool call omits `projectPath`. Set this when multiple projects are open in Rider (otherwise Rider errors "Unable to determine the target project"). Get it from the "Currently open projects" list in that error, or the project root. |
| `RIDER_ESCALATE` | `1` | `0`/`false`/`off` disables auto-escalation (see below). |
| `RIDER_ESCALATE_LIMIT` | `500` | When a result looks truncated, the proxy re-fetches once with this larger limit to learn the true count. |
| `RIDER_MAX_LINE_CHARS` | `200` | Max chars of each match's code snippet (prevents one giant generated line from blowing the budget). |
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
| Tool returns "Unable to determine the target project" | Multiple projects open in Rider, no `projectPath` | Set `RIDER_PROJECT_PATH` to the project root (the error lists open projects), or pass `projectPath` per call. |
| Tool returns "`projectPath`=… doesn't correspond to any open project" | The project is **not open in Rider** | Rider MCP only searches projects open in the IDE. Open the project in Rider (it must finish indexing), then retry. The error lists the currently-open projects. |
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
