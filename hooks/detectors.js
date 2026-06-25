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

// A `find` doing FILE-OPS (not a search-to-read): an action flag (-exec/-delete/-print0/…) or `-type d`
// means it's enumerating files to ACT on (backup, copy, cleanup), NOT hunting code for the model to read.
// Rider's index-based file search is token-capped, so it's the WRONG substitute there — a capped list
// would silently drop files from a copy/delete. So such a find is never treated as a code search.
// (Ported from vs-token-safer 0.28.x, #147 — live-found: a UE-depot backup find got blocked.)
const FIND_ACTION_RE = /\s-(exec|execdir|delete|ok|okdir|print0|fprint0?|fls|fprintf)\b/;
const FIND_TYPE_DIR_RE = /\s-type\s+d\b/;
export function isFindFileOps(segment) {
  return execOf(segment) === "find" && (FIND_ACTION_RE.test(segment) || FIND_TYPE_DIR_RE.test(segment));
}

// File-operation executables — when ANY segment of a command is one of these, a `find` segment in the
// same command is PLUMBING for that op (the file list feeds cp/tar/xargs/…), not an interactive code
// search. So such a find is excluded from the nudge even without its own -exec (`find … -name '*.cpp' |
// xargs cp`, `du …; find … -name '*.uproject'` during a backup). grep segments are NOT relaxed (a literal
// grep inside a pipeline is usually content filtering, and a non-search session can still RIDER_ENFORCE=0).
export const FILE_OPS_EXECS = new Set([
  "cp", "mv", "rm", "tar", "rsync", "xargs", "zip", "unzip", "7z", "cpio", "install",
  "ln", "du", "df", "chmod", "chown", "mkdir", "touch", "dd", "scp", "robocopy", "pax",
]);
export function hasFileOpsContext(segments) {
  return segments.some((s) => FILE_OPS_EXECS.has(execOf(s)));
}

// A single Bash command segment that is a code-symbol search (grep/rg/ack/ag/findstr/`find -name`/
// `git grep` over C/C++/C# source), not aimed at a log/build/text path.
export function isCodeSearchSegment(segment) {
  const exec = execOf(segment);
  const s = String(segment).toLowerCase();
  const isSearch =
    SEARCH_EXECS.has(exec) || (exec === "find" && /\s-i?name(\s|$)/.test(s)) || isGitGrepSegment(segment);
  if (!isSearch) return false;
  if (isFindFileOps(segment)) return false; // a file-ops find is not a code search
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

// The basename of a glob pattern (last path segment; a {ts,tsx} brace-set is kept as a hint).
export function globBasename(pat) {
  const seg = String(pat || "").replace(/\\/g, "/").split("/").pop() || "";
  return seg.replace(/[{}]/g, "");
}

// The built-in Glob TOOL targeting code: a code-ext glob (`**/*.cpp`) or a code dir in the path
// (`Source/…`). A doc/log/asset glob/path is skipped. High-precision (no generic `Name.ext` clause) so a
// `.uasset`/asset glob isn't pestered — warn-only, like the Grep-tool nudge.
export function isCodeGlobTool(ti) {
  if (!ti || typeof ti !== "object") return false;
  const base = globBasename(ti.pattern).toLowerCase();
  const p = String(ti.path || "").replace(/\\/g, "/").toLowerCase();
  if (TEXT_TARGET_RE.test(base) || TEXT_TARGET_RE.test(p)) return false;
  return CODE_EXT_RE.test(base) || CODE_DIR_RE.test(p);
}

// Split a Bash command into segments and test if ANY is a code search (mirrors the hook's logic).
// A `find` in a command that also runs a file-op (cp/tar/xargs/du/…) is plumbing for that op, not a code
// search — excluded here so the `discover` analyzer and the hook classify a backup/copy script identically.
export function bashHasCodeSearch(command) {
  const segments = String(command || "").split(/\|\||&&|[|;&\n]/g);
  const fileOps = hasFileOpsContext(segments);
  return segments.some(
    (seg) => seg.trim() && isCodeSearchSegment(seg) && !(fileOps && execOf(seg) === "find"),
  );
}
