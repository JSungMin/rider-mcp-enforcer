# Security Policy

## Supported versions

Security fixes are applied to the **latest release** only. Older versions are not backported.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Open a **[private security advisory](https://github.com/JSungMin/rider-mcp-enforcer/security/advisories/new)**
on this repository. Describe the issue, steps to reproduce, and potential impact.

**Expected response:** best-effort; this is a hobby project maintained by one person. Expect an
acknowledgement within a few days and a fix or assessment within a reasonable timeframe, but no
formal SLA applies.

## Scope

- **rider-mcp-enforcer** — the proxy forwards search queries to JetBrains Rider's MCP server on
  `localhost`. It does not open outbound connections to the internet and does not exfiltrate source
  code or query results.
- **gamedev-log-analyzer** — reads game-engine/build log files from your local disk. It does not
  upload log content anywhere.

Neither plugin collects or transmits user data. See [PRIVACY.md](PRIVACY.md) for the full data
handling statement.

## Out of scope

- Vulnerabilities in JetBrains Rider's own MCP server.
- Issues that require physical access to the machine or compromising the OS user account.
- Dependency vulnerabilities with no plausible exploitation path through this plugin.
