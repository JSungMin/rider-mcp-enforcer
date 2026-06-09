# Benchmark: Rider MCP (this plugin) vs Bash grep

Benchmarks here are **A/B by default**: the same query run **without the plugin** (Arm A — raw
ripgrep, i.e. what the model receives from a `grep`) versus **with the plugin** (Arm B — Rider MCP,
summarized and token-capped). Measured live against a real Unreal Engine 5 project open in Rider
2025.2 (MCP SSE on a local port). Machine: Windows, Node 24, ripgrep 14. Token estimate = UTF-8
bytes ÷ 4 (approximate).

> No source code, file paths, or project symbol names are reproduced here — only aggregate counts,
> sizes, and timings. The queries below are **public Unreal Engine framework symbols** (`AActor`,
> `UObject`, …), not symbols from the measured project.

## A/B across several queries (the representative case)

Four framework symbols, `limit=200`, cap 50, median of 2 runs. Arm A is `rg` over the whole project;
"capped@250" is what Claude Code's built-in Grep tool would actually deliver (it truncates at ≈250
lines). Arm B is `search_text` through the proxy (raw Rider JSON → summarized `file:line  code`).

| Query | A · grep whole (lines / ~tok) | A · grep capped@250 (~tok) | B · Rider summarized (items / ~tok) | B · raw (~tok) | Tokens saved (whole / capped) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `AActor` | 147 / 5,301 | 5,301 | 151 / **1,460** | 9,507 | 72% / 72% |
| `UObject` | 699 / 30,598 | 12,620 | 200 / **1,790** | 14,932 | **94%** / 86% |
| `BeginPlay` | 135 / 3,877 | 3,877 | 135 / **988** | 7,430 | 75% / 75% |
| `Tick` | 226 / 8,614 | 8,614 | 200 / **1,193** | 12,451 | 86% / 86% |

**Aggregate (median): ~80% fewer tokens** vs whole-project grep, **~80%** vs capped grep. Two effects
compound: **summarization** of the raw Rider JSON (e.g. `UObject` 14,932 → 1,790 ≈ 88%; `Tick`
12,451 → 1,193 ≈ 90%) and **capping** the long tail. Savings scale with match frequency — the more a
symbol occurs, the more grep dumps and the more the plugin saves (see the extreme case below).

Reproduce with the bundled harness (counts only, never content):

```bash
# from proxy/
RIDER_MCP_SSE_URL="http://127.0.0.1:<port>/sse" RIDER_PROJECT_PATH="D:/Path/To/Project" \
  Q="AActor,UObject,BeginPlay,Tick" NARROW="Source" node bench-ab.mjs
```

## High-frequency single symbol (extreme case)

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

# Logs: A/B (gamedev-log-analyzer)

Same A/B framing for the bundled log analyzer: **Arm A** = paste the raw editor log into context;
**Arm B** = the `gamedev-log` CLI (summary / search / locate / diff). Measured live against a real
Unreal Engine 5 project's `Saved/Logs` (two real editor logs of different sizes). Token ≈ bytes ÷ 4.
No log lines are reproduced — only sizes.

| Operation (Arm B) | Editor log ~253 KB (~63,212 tok raw) | Editor log ~1.07 MB (~267,117 tok raw) |
| --- | ---: | ---: |
| `summary` (severity counts + top categories) | ~123 tok · **99.8%** fewer | ~129 tok · **99.95%** fewer |
| `search` Warning+ (dedup groups by callsite) | ~1,228 tok · 98.1% fewer | ~1,905 tok · 99.3% fewer |
| `search` Error+ (dedup groups by callsite) | ~313 tok · 99.5% fewer | ~476 tok · 99.8% fewer |
| `locate` Error+ (`file:line` jump list) | — | ~78 tok · 99.97% fewer |
| `fields` (4 scalar columns) † | ~134 tok vs ~2,066 · **93.5%** fewer | ~141 tok vs ~2,180 · **93.5%** fewer |
| `diff` Warning+ (delta of two runs) | ~1,053 tok vs ~330,329 tok for pasting both raw · **99.7%** fewer | |

† `fields` **scalarizes** a log — it pulls just the requested scalar columns out of matching lines
into a compact table. Its fair baseline is not the whole log but the **raw lines you'd `grep` to read
those scalars** (here ~56–66 matching lines); the columnar form drops the timestamp/log-prefix/body
noise around each value. The win is larger on real **trace logs** that dump the same scalar keys every
frame (hundreds–thousands of rows), where the columns stay dense while raw lines explode.

**The win grows with log size** — raw logs scale linearly (a 1 MB log is ~267k tokens), while the
summary stays flat (~130 tokens) because it reports counts, not bodies. `search`/`locate` stay small
by deduping repeated lines into templated groups and capping. `diff` reads two runs and returns only
what changed, instead of pasting both logs to compare.

# Reproduce

```bash
# grep side
rg -n "<Symbol>" "<project>/<game-source-dir>"      # narrow scope
rg -n "<Symbol>" "<project>"                          # whole repo (incl Engine)

# Rider MCP side, A/B (from proxy/)
RIDER_MCP_SSE_URL="http://127.0.0.1:<port>/sse" RIDER_PROJECT_PATH="<project>" \
  Q="AActor,UObject,BeginPlay" NARROW="Source" node bench-ab.mjs

# Logs A/B (from repo root) — counts only, never log content.
# FIELDS (optional) adds the scalar-extraction row, compared vs grep of the matching lines.
LOG="<project>/Saved/Logs/<Editor>.log" LOG_B="<project>/Saved/Logs/<older>.log" \
  FIELDS="Key1,Key2,ts" node gamedev-log-analyzer/eval/bench-ab.mjs
```
