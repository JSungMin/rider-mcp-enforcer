---
description: Turn on / connect Rider's MCP server when search tools report "not connected". Probes Rider, gives the exact enable steps, and applies the detected SSE URL.
---

# Rider plugin — enable / connect Rider MCP

Use when the `rider-search` tools say "not connected" or only `rider_status` shows.

1. Call the `rider_enable` tool. It probes localhost and tells you whether **Rider is running but its
   MCP server is off** vs **Rider isn't running**, with the exact steps.
2. If it reports an SSE URL was detected, apply it: `rider_setup { "riderSseUrl": "<url>" }` → then
   `/reload-plugins`.
3. If not detected: Rider → **Settings | Tools | MCP Server → Enable MCP Server → Copy SSE Config**,
   then `rider_setup { "riderSseUrl": "<that URL>" }` → `/reload-plugins`.
4. Don't want to enable it now? Tell the user they can set `RIDER_ENFORCE=0` so Bash grep isn't
   blocked in the meantime.
