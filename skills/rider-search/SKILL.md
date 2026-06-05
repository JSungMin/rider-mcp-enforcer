---
description: Routing rules for code search in JetBrains Rider projects — use the Rider MCP symbol/reference/file tools instead of Bash grep. Use whenever searching for a symbol, definition, function, variable, type, or finding usages/references in a C#/.NET or Unreal C++ codebase open in Rider.
---

# Rider search routing

This project is open in JetBrains Rider with the Rider MCP server connected (server name: `rider-search`). Karpathy-style rules: do the listed thing, do not improvise.

## Rules
- Symbol / definition / type lookup → ALWAYS call `find_symbol` first. Never `grep`/`rg` for this.
- Usages / references / call sites of a symbol → `find_references`. Never grep for call sites.
- File by name → the Rider file-search tool. Never `find -name` for source files.
- Symbols in a file / outline → `list_file_symbols`.
- Type info / signature / docs → `get_symbol_info`.
- Rename a symbol → `rename_refactoring` (updates all references). Never sed/replace across files for a rename.
- Bash `grep`/`rg`/`find` is a LAST RESORT — only for non-code text (logs, comments, config) or when Rider MCP is unavailable.

## Why
- Rider's index resolves real definitions/usages; grep returns string matches → false positives, and misses macro/`UPROPERTY`/generated symbols in Unreal C++.
- The `rider-search` proxy token-caps responses; grep over a large UE codebase floods context with thousands of lines.
- Faster: indexed lookup, no full-tree scan.

## Fallback
If a `rider-search` tool errors with "not connected" (or only a `rider_status` tool exists),
Rider MCP is OFF. Tell the user to enable it (Rider → Settings | Tools | MCP Server → Enable →
Copy SSE Config) and set `RIDER_MCP_SSE_URL`. Until then, code-grep is blocked by the hook — the
user can set `RIDER_ENFORCE=0` to allow grep as a fallback. Do not loop on blocked grep; surface the
fix and move on.

> Note: tool names above match the JetBrains Rider MCP server (2025.2+). If a name differs in
> your Rider build, check the `rider-search` tool list and map accordingly.
