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

### projectPath / open projects
- Rider MCP only searches projects **currently open in the IDE** (and finished indexing). A path that
  isn't open returns "doesn't correspond to any open project" — tell the user to open it in Rider.
- Rider errors if multiple projects are open and `projectPath` is omitted. Pass `projectPath`, or have
  the user set `RIDER_PROJECT_PATH` so the proxy injects it. If a call returns "Unable to determine the
  target project" with a numbered project list, ask the user which project, then pass its path.

### No dedicated find-usages
This Rider MCP build has **no semantic find-references/find-usages tool**. To find references, use
`search_text`/`search_regex` on the symbol name (string match, like grep but indexed + token-capped).
Don't claim semantic usage results you didn't get.

## Inline lookup vs. delegating to the `code-locator` subagent
- One or two quick lookups whose results you want in front of you: call the Rider tool inline. That's
  the cheapest path. A subagent spends ~15k tokens of its own to hand back ~300, so it's wasteful for a
  single lookup.
- The moment you reach a third *related* lookup, or you already know this is a multi-step trace (find
  the symbol, then its callers, then where those are declared), hand the whole investigation to the
  `code-locator` subagent in one call. It runs every lookup in its own context and returns one compact
  `file:line` table, so the raw results never pile up in yours.
- Rule of thumb: inline for 1–2; batch-delegate at 3+ related lookups or any multi-step trace. Don't
  spawn a subagent for a single lookup, and don't run ten sequential inline lookups when one delegation
  would do. "Related" is the signal — count alone doesn't decide it.

## Refactoring: rename / move / reformat (use Rider, never text replace)
Renaming a function, variable, class, field, or type is a **semantic** operation. Rider does it
correctly across the whole project; a text find-and-replace does not.

- **Rename any symbol → `rename_refactoring`** (args: `pathInProject`, `symbolName`, `newName`, plus
  `projectPath` when known). Rider updates **every** reference project-wide, including other files, and
  won't touch a substring, a comment, or a same-named but unrelated symbol. This is ALWAYS how you
  rename. Never use `sed`/`perl -i`, a multi-file `Edit`, or `replace_text_in_file` to rename a symbol —
  those hit partial matches and comments, miss overloads and cross-file refs, and silently break the build.
- **Move a C#/.NET type to another namespace → `move_type_to_namespace`** (args: `filePath`,
  `typeName`, `targetNamespace`). Updates the declaration and all references across the solution.
- **Reformat a file → `reformat_file`.**
- `replace_text_in_file` is for a literal text edit (a string literal, a comment), NOT for renaming a symbol.

A rename is a single semantic call that does the whole job, so run it **inline** — it is not a
multi-step investigation and needs no subagent. If you don't know the exact `symbolName` or its path,
do one `search_symbol` first, then rename. If the result carries a `⚠ INCOMPLETE` banner or Rider
reports the symbol is ambiguous, stop and confirm with the user before renaming.

## Incomplete results — STOP and ask the user
If a tool result contains a `⚠ INCOMPLETE RESULTS` banner, the proxy already auto-raised the limit
once and the match set is STILL not exhaustive. You are seeing a partial list.

- For finding **all references**, **refactoring**, **renaming**, or any edit that must touch every call
  site: do NOT act on the partial set — you will miss occurrences and write wrong code. Present the
  three options from the banner to the user and let them choose (raise `RIDER_MAX_RESULTS`/limit,
  narrow with `paths`, or confirm partial is OK).
- For casual "show me roughly where X is" lookups: a representative partial set is usually fine; say so.

Never silently treat a banner-flagged result as complete.

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
