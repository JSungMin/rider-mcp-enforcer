#!/usr/bin/env node
/*
 * rider-mcp-enforcer — PreToolUse hook
 * Blocks Bash code-symbol searches (grep/rg/ack/ag/findstr/find -name over source files)
 * and tells Claude to use the Rider MCP tools instead. Raw text searches (logs, md, json,
 * config) are allowed through to avoid false positives.
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block, stderr shown to the model.
 */

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = ((JSON.parse(input).tool_input) || {}).command || "";
  } catch {
    process.exit(0); // unparseable — don't block
  }
  if (!cmd) process.exit(0);

  // Escape hatch: if Rider MCP is disabled/unavailable, blocking grep would leave Claude
  // with no way to search code. Set RIDER_ENFORCE=0 (or false/off) to disable blocking.
  const enforce = String(process.env.RIDER_ENFORCE ?? "1").toLowerCase();
  if (enforce === "0" || enforce === "false" || enforce === "off") process.exit(0);

  const c = cmd.toLowerCase();

  // Does the command invoke a text-search tool?
  const usesSearch =
    /(^|[|;&]|\s)(grep|rg|ack|ag|findstr)(\s|$)/.test(c) ||
    /(^|[|;&]|\s)find\s[^|;&]*\s-name(\s|$)/.test(c);
  if (!usesSearch) process.exit(0);

  // Signals that the target is CODE (so a symbol-aware tool is better).
  const codeExt = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs)\b/.test(c);
  const codeDir = /(^|[\s"'/\\])(src|source|sources|engine|plugins)[\\/]/.test(c);

  // Signals the target is NON-code text — never block these.
  const textTarget =
    /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b/.test(c) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(c);

  if ((codeExt || codeDir) && !textTarget) {
    process.stderr.write(
      "[rider-mcp-enforcer] Blocked a code-symbol search via Bash.\n" +
        "Use the Rider MCP tools (server: 'rider-search') instead:\n" +
        "  - definition / type / symbol  -> find_symbol\n" +
        "  - usages / references         -> find_references\n" +
        "  - symbols in a file / outline -> list_file_symbols\n" +
        "They query Rider's live index: more accurate (real defs/usages, no string false-positives,\n" +
        "resolves macros/UPROPERTY) and token-capped. If you genuinely need raw text search over\n" +
        "non-code (logs, comments, config), re-run targeting a non-code file."
    );
    process.exit(2); // block
  }
  process.exit(0);
});
