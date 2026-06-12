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
    env: { ...process.env, ...extraEnv },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}
const grep = (ti, env) => runHook({ tool_name: "Grep", tool_input: ti }, env);

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
