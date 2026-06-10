---
description: Show or set Bash log-grep enforcement (block / warn / off) — controls whether raw grep/tail/cat over .log/.jsonl/Logs is intercepted and steered to gamedev-log.
---

# gamedev-log-analyzer — enforcement control

A `PreToolUse` hook intercepts raw Bash log reads (`grep`/`rg`/`ack`/`ag`/`findstr`/`tail`/`head`/`cat`
over a `.log` / `.jsonl` / rotated `.log.N` file or a `Logs/` · `Saved/Logs/` path) and steers them to
`gamedev-log`, which parses + dedups + token-caps instead of dumping raw lines into context. Code grep
(`.cpp`/`.cs`/`src/…`) and non-log reads pass through untouched.

Run the CLI through Bash (no setup; pure Node):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce            # show current mode + source
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce warn       # allow, but nudge (soft)
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce off        # disable enforcement
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce block      # re-enable (default)
```

Modes:
- **block** *(default)* — deny the raw read (exit 2) and show the `gamedev-log` equivalent. Friendly
  message, but the command does **not** run.
- **warn** — allow the command, print the same nudge (soft).
- **off** — silent passthrough, no enforcement.

Mode precedence: env **`GDLOG_ENFORCE`** > `~/.gamedev-log-analyzer/config.json` (`"enforce"`) > default
`block`. For a one-shot bypass in the current shell, prefix the command with `GDLOG_ENFORCE=off`. After
changing the persisted mode, run `/reload-plugins`.

When a user hits the block but genuinely needs the raw bytes (e.g. `tail -f` live-watching), suggest
`enforce warn` (or `off`) rather than working around the hook.
