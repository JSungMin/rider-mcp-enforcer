# Benchmark: Rider MCP (this plugin) vs Bash grep

Real measurement on a live setup. Query: a single project class name (call it `<Symbol>`) that has
**~2,400 textual occurrences** in a large Unreal Engine 5 codebase open in Rider 2025.2 (MCP SSE on a
local port). Machine: Windows 11, Node 24, ripgrep. Token estimate = UTF-8 bytes ÷ 4 (approximate).

> No source code, file paths, or symbol names from the measured project are reproduced here — only
> aggregate counts, sizes, and timings.

## Results

| Path | Wall time | Results delivered to the model | Tokens (~) |
| --- | ---: | --- | ---: |
| **Bash grep, game source dir** | **382 ms** | 2,463 lines (all matches) | **114,110** |
| **Bash grep, whole repo** (incl. Engine) | **55,006 ms** | 3,550 lines (all matches) | **195,612** |
| **Rider MCP text search** (plugin, summarized, cap 50) | ~870 ms | 50 of 200+ (`file:line  code`) | **~1,700** |
| **Rider MCP symbol search** (plugin, summarized) | ~2,000 ms | 25 files (`file:line`) | **~922** |

## Token savings (the dominant, always-on win)

Plugin text search vs grep:

- vs **game-source** grep: `~1,700` vs `114,110` → **98.5% fewer (~67×)**
- vs **whole-repo** grep: `~1,700` vs `195,612` → **99.1% fewer (~115×)**

Where the saving comes from (same query, decomposed):
- **Summarization** of the raw Rider JSON response (same 200 items): `~13,000` → `~1,700` tokens = **~87%**.
- **Capping** (`limit` / `RIDER_MAX_RESULTS`) drops the long tail grep would dump verbatim.

Even against a *line-capped* grep (Claude Code's built-in Grep tool caps output ≈250 lines ≈ ~11,600
tokens at this match density), the summarized result (~1,700) is still **~85% fewer tokens** — and
every line is a real `file:line  match`, not raw bytes.

## Search time — depends on scope (honest)

- vs **whole-repo** grep (the common case: Claude doesn't know where a symbol lives and scans the repo
  root): `~870 ms` vs `55,006 ms` → **~63× faster**. Indexed lookup beats scanning the UE Engine tree.
- vs a **narrow** grep over just the game-source dir: `~870 ms` vs `382 ms` → grep ~2.3× faster.
  Ripgrep is very fast on a small, known scope; the MCP round-trip (SSE + Rider) has fixed overhead.

**Takeaway:** tokens win massively and unconditionally (~98–99%). Wall-clock wins big when the scope
is large/unknown (Engine included) and loses slightly when grep is already narrowly scoped.

## Accuracy difference (and why)

The two paths optimize differently — it is a **precision/recall trade**, not "one is simply correct":

| Aspect | Bash grep | Rider MCP (this plugin) |
| --- | --- | --- |
| Match basis | Literal substring | Indexed text (`search_text`) / symbol index (`search_symbol`) |
| Recall (completeness) | 100% of literal hits (2,463) | **Capped at `limit`/`RIDER_MAX_RESULTS`** — top N only |
| Precision (relevance) | Low — matches comments, includes, and substrings (e.g. a query of `Foo` also hits `FooBar`, `FooComponent`) | Higher — `search_symbol` returns distinct symbol candidates; summary keeps `file:line  code` |
| Result shape | Raw lines, undeduped | `file:line  code`, deduped to the cap |

**Degree of difference, measured here:**
- **Recall:** with the default cap (50), the plugin surfaces ~50 of 2,400+ occurrences. The other
  ~98% are intentionally withheld — they are overwhelmingly comments/includes/substring noise, not
  distinct definitions. If you need an exhaustive list, raise `limit`/`RIDER_MAX_RESULTS` or use grep
  deliberately.
- **Precision:** grep's 2,463 "matches" include every substring occurrence; the plugin's symbol search
  returned 25 distinct candidate files. So grep over-reports by ~100× at this query.
- **Known weakness:** on Unreal **C++**, `search_symbol` may point at a file's line 1 (filename/path
  match) rather than the exact class-declaration line — a Rider-side indexing limitation. For precise
  locations, `search_text` returns the real `file:line  code`. The plugin's skill instructs Claude to
  prefer `search_text` when a symbol hit looks off.

Net: for **navigation** (jump to the definition / see representative usages), the plugin is more
accurate *and* far cheaper. For an **exhaustive audit** of every textual occurrence, raise the cap or
use grep on purpose.

## Reproduce

```bash
# grep side
rg -n "<Symbol>" "<project>/<game-source-dir>"      # narrow scope
rg -n "<Symbol>" "<project>"                          # whole repo (incl Engine)

# MCP side (from proxy/)
RIDER_MCP_SSE_URL="http://127.0.0.1:<port>/sse" RIDER_PROJECT_PATH="<project>" Q="<Symbol>" node bench.mjs
```
