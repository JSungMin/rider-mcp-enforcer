#!/usr/bin/env node
/*
 * rider-mcp-enforcer — PreToolUse hook
 * Blocks Bash code-symbol searches (grep/rg/ack/ag/findstr, or `find -name`, over source
 * files) and tells Claude to use the Rider MCP tools instead. Raw text searches (logs, md,
 * json, config) pass through.
 *
 * It only triggers when a search tool is the ACTUAL executable of a command segment — so
 * `node setup.mjs ...`, `cd ".../plugins/..."`, etc. are never blocked just because a path
 * or argument happens to contain "rg", "plugins", "source", and the like.
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block, stderr shown to the model.
 */

const SEARCH_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr"]);

function execOf(segment) {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  // skip leading env-var assignments: FOO=bar grep ...
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  let exec = (tokens[i] || "").toLowerCase();
  // strip any path prefix and a Windows extension → basename
  exec = exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, "");
  return exec;
}

function isCodeSearchSegment(segment) {
  const exec = execOf(segment);
  const s = segment.toLowerCase();
  const isSearch = SEARCH_EXECS.has(exec) || (exec === "find" && /\s-name(\s|$)/.test(s));
  if (!isSearch) return false;

  const codeExt = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs)\b/.test(s);
  const codeDir = /(^|[\s"'/\\])(src|source|sources|engine|plugins)[\\/]/.test(s);
  const textTarget =
    /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b/.test(s) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(s);

  return (codeExt || codeDir) && !textTarget;
}

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

  // Evaluate each shell segment independently; only an actual search-tool invocation counts.
  const segments = cmd.split(/\|\||&&|[|;&\n]/g);
  const blocked = segments.some((seg) => seg.trim() && isCodeSearchSegment(seg));
  if (!blocked) process.exit(0);

  process.stderr.write(
    "[rider-mcp-enforcer] Blocked a code-symbol search via Bash.\n" +
      "Use the Rider MCP tools (server: 'rider-search') instead:\n" +
      "  - symbol / definition         -> search_symbol  (args: q, limit, projectPath)\n" +
      "  - text / references in code   -> search_text or search_regex  (q, paths, limit)\n" +
      "  - file by name                -> search_file / find_files_by_name_keyword\n" +
      "  - type info at a position     -> get_symbol_info  (filePath, line, column)\n" +
      "They use Rider's index, are token-capped by the proxy. If multiple projects are open,\n" +
      "pass projectPath (or set RIDER_PROJECT_PATH). For raw non-code text (logs, config),\n" +
      "re-run targeting a non-code file, or set RIDER_ENFORCE=0."
  );
  process.exit(2); // block
});
