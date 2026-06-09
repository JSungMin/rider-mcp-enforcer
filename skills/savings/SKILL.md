---
description: Report how many tokens the rider-mcp-enforcer plugin has saved. Use when the user asks "how much did the plugin save", "token savings", or runs /rider-mcp-enforcer:savings.
disable-model-invocation: true
---

# Rider plugin — token savings

Call the `rider_savings` MCP tool (server: `rider-search`) and show the user its output verbatim:
cumulative summarized calls, raw vs sent tokens, total saved (and %), and build-artifact noise items
dropped.

If the `rider-search` server is unavailable, run instead:
`node "${CLAUDE_PLUGIN_ROOT}/proxy/stats.mjs"`
and report its output.

Note: "saved" = tokens that would have been spent forwarding Rider's raw responses, minus what the
proxy actually sent after summarizing/capping/excluding. It does not include savings vs Bash grep
(grep isn't run), which are typically far larger — see BENCHMARK.md for that comparison.

To reset the counter, call the `rider_savings_reset` tool.
