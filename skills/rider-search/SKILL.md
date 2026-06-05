---
description: Routing rules for code search in JetBrains Rider projects — use the Rider MCP symbol/reference/file tools instead of Bash grep. Use whenever searching for a symbol, definition, function, variable, type, or finding usages/references in a C#/.NET or Unreal C++ codebase open in Rider.
---

# Rider search routing

This project is open in JetBrains Rider with the Rider MCP server connected (server name: `rider-search`). Karpathy-style rules: do the listed thing, do not improvise.

## Tools (real Rider MCP 2025.2+ names)
- Symbol / definition → `search_symbol`  (args: `q`, `limit`, `include_external`, `paths`, `projectPath`). Never `grep`/`rg` for this.
- File by name → `search_file` or `find_files_by_name_keyword` / `find_files_by_glob`. Never `find -name` for source files.
- Text / regex in code (also the way to find references — see note) → `search_text` / `search_regex` (or `search_in_files_by_text` / `search_in_files_by_regex`).
- Type info / signature at a position → `get_symbol_info`  (args: `filePath`, `line`, `column`).
- Rename a symbol → `rename_refactoring`  (args: `pathInProject`, `symbolName`, `newName`). Never sed/replace across files for a rename.
- `read_file` / `get_file_text_by_path` to read, not `cat`.

### projectPath
Rider errors if multiple projects are open and `projectPath` is omitted. Pass `projectPath`, or have
the user set `RIDER_PROJECT_PATH` so the proxy injects it. If a call returns "Unable to determine the
target project" with a numbered project list, ask the user which project, then pass its path.

### No dedicated find-usages
This Rider MCP build has **no semantic find-references/find-usages tool**. To find references, use
`search_text`/`search_regex` on the symbol name (string match, like grep but indexed + token-capped).
Don't claim semantic usage results you didn't get.

## Why
- `search_symbol` uses Rider's index (no full-tree scan, token-capped by the proxy).
- grep over a large UE codebase floods context with thousands of lines; the proxy caps responses.
- Caveat: on Unreal C++, `search_symbol` quality varies (may return file/name matches rather than the
  exact class). Verify the result; fall back to `search_text` if the symbol result looks off.

## Fallback
If a `rider-search` tool errors with "not connected" (or only a `rider_status` tool exists),
Rider MCP is OFF. Tell the user to enable it (Rider → Settings | Tools | MCP Server → Enable →
Copy SSE Config) and set `RIDER_MCP_SSE_URL`. Until then, code-grep is blocked by the hook — the
user can set `RIDER_ENFORCE=0` to allow grep as a fallback. Do not loop on blocked grep; surface the
fix and move on.

> Note: tool names above match the JetBrains Rider MCP server (2025.2+). If a name differs in
> your Rider build, check the `rider-search` tool list and map accordingly.
