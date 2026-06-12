/*
 * rider-mcp-enforcer — pure code-search detectors (ESM, ZERO side effects on import: no stdin,
 * no process.exit, no console, no I/O). Shared single source of truth between the PreToolUse hook
 * (hooks/block-code-grep.js) and the `discover` analyzer (proxy/discover.mjs) so the two can never
 * drift. The hook owns ALL stdin/exit/IO; this module only classifies.
 */

export const SEARCH_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr"]);

// ripgrep --type aliases that denote C/C++/C# source (the Grep tool's `type` forwards to rg).
export const CODE_TYPES = new Set(["c", "cpp", "csharp", "cs", "cxx", "cc", "cuda"]);

export const CODE_EXT_RE = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs)\b/;
export const CODE_DIR_RE = /(^|[\s"'/\\])(src|source|sources|engine)[\\/]/;
export const TEXT_TARGET_RE = /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b/;

export function execOf(segment) {
  const tokens = String(segment).trim().split(/\s+/);
  let i = 0;
  // skip leading env-var assignments: FOO=bar grep ...
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  let exec = (tokens[i] || "").toLowerCase();
  // strip any path prefix and a Windows extension → basename
  exec = exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, "");
  return exec;
}

// `git grep` scans the tracked source tree by DEFAULT (no path/ext needed), so it's a code search on
// its own — unlike a bare `grep` over the cwd. Caught even without an explicit code path/ext.
export function isGitGrepSegment(segment) {
  return execOf(segment) === "git" && /(^|\s)git\s+grep(\s|$)/i.test(String(segment));
}

// A single Bash command segment that is a code-symbol search (grep/rg/ack/ag/findstr/`find -name`/
// `git grep` over C/C++/C# source), not aimed at a log/build/text path.
export function isCodeSearchSegment(segment) {
  const exec = execOf(segment);
  const s = String(segment).toLowerCase();
  const isSearch =
    SEARCH_EXECS.has(exec) || (exec === "find" && /\s-name(\s|$)/.test(s)) || isGitGrepSegment(segment);
  if (!isSearch) return false;
  const textTarget =
    TEXT_TARGET_RE.test(s) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(s);
  // git grep defaults to the tracked code tree → a code search unless it explicitly names a text/log path.
  if (isGitGrepSegment(segment)) return !textTarget;
  const codeExt = CODE_EXT_RE.test(s);
  const codeDir = CODE_DIR_RE.test(s);
  return (codeExt || codeDir) && !textTarget;
}

// The built-in Grep TOOL targeting code: an explicit code-ext glob, an rg code `type`, or a code
// file/dir path. A bare cwd Grep (no path/glob/type) or an explicit non-code target → false.
export function isCodeGrepTool(ti) {
  if (!ti || typeof ti !== "object") return false;
  const glob = String(ti.glob || "").toLowerCase();
  const type = String(ti.type || "").toLowerCase();
  const p = String(ti.path || "").replace(/\\/g, "/").toLowerCase();
  if (glob && TEXT_TARGET_RE.test(glob)) return false;
  if (p && TEXT_TARGET_RE.test(p)) return false;
  const globIsCode = !!glob && CODE_EXT_RE.test(glob);
  const typeIsCode = CODE_TYPES.has(type);
  const pathIsCode = (!!p && CODE_EXT_RE.test(p)) || CODE_DIR_RE.test(p);
  return globIsCode || typeIsCode || pathIsCode;
}

// Split a Bash command into segments and test if ANY is a code search (mirrors the hook's logic).
export function bashHasCodeSearch(command) {
  return String(command || "")
    .split(/\|\||&&|[|;&\n]/g)
    .some((seg) => seg.trim() && isCodeSearchSegment(seg));
}
