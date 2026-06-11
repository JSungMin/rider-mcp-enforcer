---
description: Scan local Claude Code transcripts and report (aggregate, local-only) how many code searches bypassed rider-search vs went through it — to find missed token savings. No proprietary content in the output.
---

# Rider plugin — discover (missed token savings)

Quantifies how often code-symbol searches went through grep/Grep-tool instead of rider-search, so you
can see where tokens leaked. Adapted from RTK's `discover`, scoped to code search only.

**Run from the project root you launched Claude Code from** (the report keys off the working directory):

```
node "${CLAUDE_PLUGIN_ROOT}/proxy/discover.mjs"            # this project, all sessions
node "${CLAUDE_PLUGIN_ROOT}/proxy/discover.mjs" --since 7  # sessions from the last 7 days
node "${CLAUDE_PLUGIN_ROOT}/proxy/discover.mjs" --all      # every project — cross-project AGGREGATE only
node "${CLAUDE_PLUGIN_ROOT}/proxy/discover.mjs" --session <path-to.jsonl>
```

It reports **aggregate counts + coarse, estimated token numbers + a coverage ratio** (searches routed
through rider-search vs bypassed). It is **local-only** — it reads transcripts, writes/transmits nothing,
and **never prints a command, file path, symbol, or any code content** (those can be proprietary). Token
counts are estimated (`chars / 4`), rounded coarsely, and labelled as estimates — don't treat them as
exact. Some "bypassed" reads are legitimate fallbacks (just-edited / unindexed files).

This is a CLI / slash command (not an MCP tool) on purpose — no always-on schema tax, no shell-approval
prompt. The same detectors that drive the enforcement hook drive this, so the two never disagree.

$ARGUMENTS
