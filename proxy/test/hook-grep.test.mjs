// Integration tests for the rider-mcp-enforcer PreToolUse hook (hooks/block-code-grep.js).
// Spawns the real hook with a piped JSON stdin payload and asserts stdout/exit — high fidelity, no
// need to refactor the stdin-driven hook into an importable module. Run via `npm test` from proxy/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "block-code-grep.js");

function runHook(payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    // Default the UI language to English so the suite is locale-independent (a ko-KR dev machine would
    // otherwise get Korean nudges and fail the English-text assertions). Localization tests override this.
    env: { ...process.env, RIDER_LANG: "en", ...extraEnv },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}
const grep = (ti, env) => runHook({ tool_name: "Grep", tool_input: ti }, env);
const glob = (ti, env) => runHook({ tool_name: "Glob", tool_input: ti }, env);

// --- Grep TOOL: fires only on an explicit code signal ---
test("Grep: code-ext glob (*.cs) → warn nudge, exit 0", () => {
  const r = grep({ pattern: "Foo", glob: "*.cs" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rider-mcp-enforcer/);
  assert.match(r.stdout, /additionalContext/);
  assert.match(r.stdout, /Grep tool/, "nudge carries the kill-metric marker");
});

test("Grep: code-ext glob (*.cpp) → warn nudge", () => {
  assert.match(grep({ pattern: "Foo", glob: "*.cpp" }).stdout, /rider-mcp-enforcer/);
});

test("Grep: rg code type (csharp) → warn nudge", () => {
  assert.match(grep({ pattern: "Foo", type: "csharp" }).stdout, /rider-mcp-enforcer/);
});

test("Grep: path under a code dir (Source/) → warn nudge", () => {
  assert.match(grep({ pattern: "Foo", path: "Source/Engine" }).stdout, /rider-mcp-enforcer/);
});

test("Grep: path to a code file (src/Foo.cs) → warn nudge", () => {
  assert.match(grep({ pattern: "Foo", path: "src/Foo.cs" }).stdout, /rider-mcp-enforcer/);
});

// --- Grep TOOL: silent where it can't confirm code or is explicitly non-code ---
test("Grep: bare cwd (no path/glob/type) → NO nudge", () => {
  const r = grep({ pattern: "Foo" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("Grep: text glob (*.md) → NO nudge", () => {
  assert.equal(grep({ pattern: "x", glob: "*.md" }).stdout.trim(), "");
});

test("Grep: non-code type (json) → NO nudge", () => {
  assert.equal(grep({ pattern: "x", type: "json" }).stdout.trim(), "");
});

test("Grep: log path → NO nudge (log domain belongs to gamedev-log-analyzer)", () => {
  assert.equal(grep({ pattern: "x", path: "Saved/Logs/Editor.log" }).stdout.trim(), "");
});

// --- agent-directed concrete call embedded in the Grep nudge ---
test("Grep: a bare-identifier nudge embeds the ready-to-use search_symbol call", () => {
  const r = grep({ pattern: "AMyActor", glob: "*.cpp" });
  assert.match(r.stdout, /search_symbol/);
  assert.match(r.stdout, /AMyActor/);
});

test("Grep: a non-identifier pattern embeds search_text (not search_symbol)", () => {
  const r = grep({ pattern: "Foo::Bar", glob: "*.cpp" });
  assert.match(r.stdout, /search_text q=/);
});

// --- Glob TOOL: warn-only nudge toward Rider's index-based file search ---
test("Glob: code-ext glob (**/*.cpp) → warn nudge with a find_files_by_name_keyword call", () => {
  const r = glob({ pattern: "**/*.cpp" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rider-mcp-enforcer/);
  assert.match(r.stdout, /find_files_by_name_keyword/);
});

test("Glob: code dir in path (Source/) → warn nudge", () => {
  assert.match(glob({ pattern: "**/*", path: "Source/Game" }).stdout, /rider-mcp-enforcer/);
});

test("Glob: doc glob (*.md) → NO nudge", () => {
  assert.equal(glob({ pattern: "**/*.md" }).stdout.trim(), "");
});

test("Glob: log glob (Saved/**/*.log) → NO nudge (logs are gamedev-log's domain)", () => {
  assert.equal(glob({ pattern: "Saved/**/*.log" }).stdout.trim(), "");
});

test("Glob: never blocks, even under RIDER_ENFORCE=block (it's a fallback, like Grep)", () => {
  const r = glob({ pattern: "**/*.cpp" }, { RIDER_ENFORCE: "block" });
  assert.equal(r.code, 0);
});

// --- Grep TOOL: warn-only, never block; off silences ---
test("Grep: RIDER_ENFORCE=block still only WARNS (the fallback is never denied)", () => {
  const r = grep({ pattern: "Foo", glob: "*.cpp" }, { RIDER_ENFORCE: "block" });
  assert.equal(r.code, 0, "Grep must never exit 2");
  assert.match(r.stdout, /additionalContext/);
});

test("Grep: RIDER_ENFORCE=0 silences the nudge", () => {
  const r = grep({ pattern: "Foo", glob: "*.cs" }, { RIDER_ENFORCE: "0" });
  assert.equal(r.stdout.trim(), "");
});

// --- Bash branch unchanged (regression) ---
test("Bash: code grep over a .cpp still nudges", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "grep -n Foo src/Foo.cpp" } });
  assert.match(r.stdout, /rider-mcp-enforcer/);
});

test("Bash: RIDER_ENFORCE=block denies a code grep (exit 2)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/" } }, { RIDER_ENFORCE: "block" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rider-mcp-enforcer/);
});

test("Bash: non-code grep (a log) passes through untouched", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "grep warning build.log" } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

// --- git grep: a code search on its own (scans tracked source by default) ---
test("Bash: `git grep Foo` nudges (tracked-code search, no explicit path needed)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git grep Foo" } });
  assert.match(r.stdout, /rider-mcp-enforcer/);
});

test("Bash: `git grep x -- '*.log'` passes (explicit text/log target)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git grep warning Saved/Logs/Editor.log" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: plain `git status` is NOT a code search (no code nudge, never blocks)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git status" } });
  assert.notEqual(r.code, 2, "git status must never be blocked as a code search");
  assert.doesNotMatch(r.stdout, /code-symbol search/, "not the code nudge (it's a VCS command)");
});

// --- excludeCommands: per-exec opt-out (finer than RIDER_ENFORCE=0) ---
test("Bash: RIDER_EXCLUDE_COMMANDS=grep leaves a grep code search alone", () => {
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "grep -n Foo src/Foo.cpp" } },
    { RIDER_EXCLUDE_COMMANDS: "grep" }
  );
  assert.equal(r.stdout.trim(), "");
});

test("Bash: RIDER_EXCLUDE_COMMANDS=rg does NOT exclude grep (still nudges)", () => {
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "grep -n Foo src/Foo.cpp" } },
    { RIDER_EXCLUDE_COMMANDS: "rg" }
  );
  assert.match(r.stdout, /rider-mcp-enforcer/);
});

// --- VCS output compaction: rewrite a read-only git/p4 command to the compacting wrapper (never blocks) ---
function vcsOut(stdout) {
  // The hook emits a JSON object on stdout for a rewrite; parse the last JSON line.
  const line = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  return line ? JSON.parse(line) : null;
}

test("Bash: `git status` → rewrite to the vcs wrapper (allow + updatedInput), exit 0", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git status --porcelain" } });
  assert.equal(r.code, 0);
  const j = vcsOut(r.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "allow");
  assert.match(j.hookSpecificOutput.updatedInput.command, /vcs\.mjs" git "status" "--porcelain"/);
});

test("Bash: `git log --oneline -5` → rewrite", () => {
  const j = vcsOut(runHook({ tool_name: "Bash", tool_input: { command: "git log --oneline -5" } }).stdout);
  assert.match(j.hookSpecificOutput.updatedInput.command, /vcs\.mjs" git "log"/);
});

test("Bash: `p4 opened` → rewrite", () => {
  const j = vcsOut(runHook({ tool_name: "Bash", tool_input: { command: "p4 opened" } }).stdout);
  assert.match(j.hookSpecificOutput.updatedInput.command, /vcs\.mjs" p4 "opened"/);
});

test("Bash: `git commit -m x` is NOT compacted (not a read-only sub)", () => {
  // a quote would also bail, so use a metachar-free non-readonly command
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git commit --amend" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: `git status | grep x` is NOT rewritten (pipeline = not a single segment)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git status | grep x" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: a quoted git command bails (no rewrite)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git log --grep='fix bug'" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: RIDER_COMPACT_VCS=0 disables the rewrite", () => {
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git status" } },
    { RIDER_COMPACT_VCS: "0" }
  );
  assert.equal(r.stdout.trim(), "");
});

test("Bash: `git grep Foo` stays a CODE nudge, not VCS compaction", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git grep Foo" } });
  assert.match(r.stdout, /rider-mcp-enforcer/);
  assert.doesNotMatch(r.stdout, /updatedInput/, "git grep is a code search, never a VCS rewrite");
});

test("Bash: a preview `p4 reconcile -n` IS rewritten (read-only)", () => {
  const j = vcsOut(runHook({ tool_name: "Bash", tool_input: { command: "p4 reconcile -n" } }).stdout);
  assert.match(j.hookSpecificOutput.updatedInput.command, /vcs\.mjs" p4 "reconcile" "-n"/);
});

test("Bash: a MUTATING `p4 reconcile` (no -n) is NOT rewritten (keeps write semantics)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "p4 reconcile" } });
  assert.equal(r.stdout.trim(), "", "must not silently turn a mutation into a preview");
});

// --- file-ops find: a backup/copy enumeration is NOT a code search (ported from vts #147) ---
test("Bash: a genuine `find … -name '*.cpp'` (no file-op) still nudges", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "find Source -name '*.cpp'" } });
  assert.match(r.stdout, /rider-mcp-enforcer/);
});

test("Bash: `find … -name '*.cpp' -exec cp …` is a file-op, NOT nudged", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "find Source -name '*.cpp' -exec cp {} backup/ ;" } });
  assert.equal(r.stdout.trim(), "", "a file-ops find must not be steered to a token-capped file list");
});

test("Bash: `find … -name '*.cpp' -delete` is a file-op, NOT nudged", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "find Source -name '*.cpp' -delete" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: `find … -name '*.cpp' | xargs cp` (file-op context) NOT nudged", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "find Source -name '*.cpp' | xargs cp -t backup" } });
  assert.equal(r.stdout.trim(), "");
});

test("Bash: a backup find under RIDER_ENFORCE=block is NOT blocked (exit 0)", () => {
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "du -sh .; find Source -name '*.uproject' -exec cp {} bak/ ;" } },
    { RIDER_ENFORCE: "block" }
  );
  assert.equal(r.code, 0, "a file-ops find must never be blocked (would corrupt a backup)");
});

test("Bash: a literal grep alongside a file-op is STILL nudged (grep isn't relaxed)", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "cp a b; grep -n Foo src/Foo.cpp" } });
  assert.match(r.stdout, /rider-mcp-enforcer/, "only find is relaxed by file-op context, not grep");
});

// --- localization: RIDER_LANG > config lang > OS locale > en ---
test("Grep: RIDER_LANG=ko → Korean nudge", () => {
  const r = grep({ pattern: "Foo", glob: "*.cs" }, { RIDER_LANG: "ko" });
  assert.match(r.stdout, /Grep 툴|코드 검색/);
});

test("Grep: RIDER_LANG=en → English nudge", () => {
  const r = grep({ pattern: "Foo", glob: "*.cs" }, { RIDER_LANG: "en" });
  assert.match(r.stdout, /Grep tool/);
});

test("Bash block: RIDER_LANG=ko → reassuring Korean (not a scary error), still exit 2", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/" } }, { RIDER_ENFORCE: "block", RIDER_LANG: "ko" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /가로챘어요|아꼈습니다/);
});

test("Bash block: RIDER_LANG=en → reassuring English header, exit 2", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/" } }, { RIDER_ENFORCE: "block", RIDER_LANG: "en" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /caught a Bash code search|nothing broke/);
});
