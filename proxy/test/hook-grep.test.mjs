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
