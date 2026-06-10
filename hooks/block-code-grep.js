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
  // NOTE: `plugins` was removed — it over-matched (`.claude/plugins/`, this repo's own plugin dirs),
  // so a `find -name X` whose path merely contained `plugins/` was wrongly flagged as a code search.
  const codeDir = /(^|[\s"'/\\])(src|source|sources|engine)[\\/]/.test(s);
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

  // Mode: env RIDER_ENFORCE > default "warn". The hard-block guarantee was always porous (the Grep
  // tool / MCP search / Read tool bypass this hook entirely), so denying-by-default paid friction for a
  // guarantee that didn't hold. Default now NUDGES (warn) and lets the command run; opt into hard
  // denial with RIDER_ENFORCE=block (or 1/on/true). RIDER_ENFORCE=0/off disables the nudge too.
  const raw = String(process.env.RIDER_ENFORCE ?? "warn").toLowerCase();
  const mode =
    ["0", "false", "off", "none", "allow"].includes(raw) ? "off"
    : ["1", "true", "on", "block", "deny", "hard"].includes(raw) ? "block"
    : "warn";
  if (mode === "off") process.exit(0);

  // Evaluate each shell segment independently; only an actual search-tool invocation counts.
  const segments = cmd.split(/\|\||&&|[|;&\n]/g);
  const blocked = segments.some((seg) => seg.trim() && isCodeSearchSegment(seg));
  if (!blocked) process.exit(0);

  const nudge =
    "[rider-mcp-enforcer] " + (mode === "block" ? "Blocked" : "Heads-up:") + " a code-symbol search via Bash.\n" +
    "Prefer the Rider MCP tools (server: 'rider-search') — token-capped, semantic (Rider's index):\n" +
    "  - symbol / definition         -> search_symbol  (args: q, limit, projectPath)\n" +
    "  - text / references in code   -> search_text or search_regex  (q, paths, limit)\n" +
    "  - file by name                -> search_file / find_files_by_name_keyword\n" +
    "  - type info at a position     -> get_symbol_info  (filePath, line, column)\n" +
    "Or delegate to the `code-locator` subagent (returns a compact file:line table). If multiple\n" +
    "projects are open, pass projectPath. Raw non-code text → re-run on a non-code file; disable with RIDER_ENFORCE=0.";

  if (mode === "warn") {
    // allow, but inject the nudge into the model's context (stderr on exit 0 isn't reliably surfaced).
    // Trailing newline for line-buffered stdout readers.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: nudge } }) + "\n"
    );
    process.exit(0);
  }
  process.stderr.write(nudge + "\n");
  process.exit(2); // block (opt-in via RIDER_ENFORCE=block)
});
