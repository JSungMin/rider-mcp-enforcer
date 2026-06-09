# docs / media

Drop README media here, then wire it up in the main READMEs.

| File | What to capture | Used in |
| --- | --- | --- |
| `demo.gif` | A terminal recording: Claude tries `grep` on `*.cpp` → hook blocks + redirects → `search_symbol` returns a token-capped result; then `/ue-log-analyzer:logs` turns a ~50 MB log into a ~2.5K-token summary. ~10–20s, ≤760px wide. | top of `README.md` / `README.ko.md` (uncomment the `<img>` placeholder) |
| `search-before-after.png` | Side-by-side: raw grep output (huge) vs the summarized Rider result. | optional, Performance section |
| `log-callsite.png` | A `log_search groupBy:"callsite"` result (sanitized — no internal paths/symbols). | optional, Editor log analysis section |

Keep media **sanitized**: no internal file paths, class/symbol names, or company/project identifiers
(see the repo's no-proprietary rule). Use a throwaway sample project for recordings.
