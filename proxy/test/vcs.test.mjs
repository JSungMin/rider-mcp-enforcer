// Tests for proxy/vcs.mjs — the VCS compaction wrapper's SAFETY guard. The default-deny check runs BEFORE
// any spawn, so these need no git/p4 toolchain. Spawns the real CLI with a piped argv. Run via `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vcs.mjs");
const run = (...args) => spawnSync(process.execPath, [VCS, ...args], { encoding: "utf8" });

test("vcs: refuses a mutating git subcommand (git commit) — exit 2, never spawns", () => {
  const r = run("git", "commit", "-m", "x");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /READ-ONLY/);
});

test("vcs: refuses git push / reset / checkout / clean", () => {
  for (const sub of ["push", "reset", "checkout", "clean"]) {
    assert.equal(run("git", sub).status, 2, `${sub} must be refused`);
  }
});

test("vcs: refuses a mutating p4 subcommand (submit / edit / revert / add)", () => {
  for (const sub of ["submit", "edit", "revert", "add"]) {
    assert.equal(run("p4", sub).status, 2, `p4 ${sub} must be refused`);
  }
});

test("vcs: refuses an unknown binary", () => {
  const r = run("svn", "status");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expected 'git' or 'p4'/);
});

test("vcs: refuses a missing subcommand", () => {
  assert.equal(run("git").status, 2);
});

test("vcs: a read-only subcommand (git status) is allowed — runs on this repo and compacts", () => {
  // proxy/ lives inside the rider-mcp-enforcer git repo, so `git status` resolves here.
  const r = run("git", "status");
  assert.equal(r.status, 0);
  // compacted shape: either "clean (no changes)." or "N change(s):" — never raw long-format prose.
  assert.match(r.stdout, /change\(s\):|clean \(no changes\)\./);
  assert.doesNotMatch(r.stdout, /On branch /, "long-format prose must have been forced to --porcelain");
});
