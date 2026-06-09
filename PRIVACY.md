# Privacy Policy

_Last updated: 2026-06-09_

This policy covers the Claude Code plugins in this repository: **rider-mcp-enforcer** and
**ue-log-analyzer**.

## Summary

**These plugins collect no personal data and transmit no user data to the author or any third party.**
All processing happens locally on your machine.

## What the plugins access

- **rider-mcp-enforcer** sends your search queries to **JetBrains Rider's MCP server on your own
  machine** (a `localhost` endpoint you configure) and summarizes the results. It does not send your
  source code anywhere else.
- **ue-log-analyzer** reads **editor log files on your local disk** (paths you configure or that are
  auto-detected) and parses them in-process. It does not upload logs anywhere.

## What is stored, and where (all local)

- Configuration files: `~/.rider-mcp-enforcer/config.json`, `~/.ue-log-analyzer/config.json`.
- A token-savings counter: `~/.rider-mcp-enforcer/stats.json` (aggregate token counts only — no code,
  no log content, no identifiers).
- The MCP server dependencies (`node_modules`) installed into the plugin's data directory.

These files stay on your machine. Uninstalling the plugin removes its data directory.

## Network activity

The only outbound network connections are:

1. **First-run dependency install** — `npm install` fetches the open-source `@modelcontextprotocol/sdk`
   package from the public npm registry. This is standard package installation; no user data is sent.
2. **Local Rider connection** — rider-mcp-enforcer connects to your Rider MCP endpoint at `localhost`.

There is **no telemetry, no analytics, no tracking, and no transmission** of your code, logs, queries,
or any personal data.

## Third parties

None. Your data is not shared, sold, or sent to the author or any third-party service.

## Open source

Both plugins are MIT-licensed and fully auditable in this repository. You can verify every network call
and file write in the source.

## Contact

Questions or concerns: open an issue at
<https://github.com/JSungMin/rider-mcp-enforcer/issues>.

## Changes

Updates to this policy will be committed to this file; the "Last updated" date reflects the latest
revision.
