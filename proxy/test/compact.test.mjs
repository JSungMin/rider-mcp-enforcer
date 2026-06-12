// Unit tests for proxy/src/compact.js — the PURE git/p4 output-compaction helpers. Deterministic, fed
// canned strings (no git/p4 toolchain needed). Run via `npm test` from proxy/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactGit, compactP4 } from "../src/compact.js";

test("git status: groups by change-type with counts + caps", () => {
  const raw = [
    " M src/A.cpp", " M src/B.cpp", " M src/C.cpp",
    "?? Logs/x.log", "?? Logs/y.log",
    "A  Source/New.cs",
  ].join("\n");
  const out = compactGit("status", raw, 60);
  assert.match(out, /6 change\(s\):/);
  assert.match(out, /modified: 3/);
  assert.match(out, /untracked: 2/);
  assert.match(out, /added: 1/);
});

test("git status: clean tree", () => {
  assert.equal(compactGit("status", "", 60), "clean (no changes).");
});

test("git status: caps the per-group file list with a +N more", () => {
  const raw = Array.from({ length: 20 }, (_, i) => ` M src/F${i}.cpp`).join("\n");
  const out = compactGit("status", raw, 4); // tiny cap → must elide
  assert.match(out, /modified: 20/);
  assert.match(out, /… \+\d+ more modified/);
});

test("git log --oneline: keeps lines, caps with +N more commits", () => {
  const raw = Array.from({ length: 10 }, (_, i) => `abc${i} commit subject ${i}`).join("\n");
  const out = compactGit("log", raw, 3);
  assert.match(out, /abc0 commit subject 0/);
  assert.match(out, /… \+7 more commit\(s\)\./);
});

test("git log (full blocks): collapses each commit to sha + subject", () => {
  const raw = [
    "commit 1111111111111111111111111111111111111111",
    "Author: A <a@x>", "Date: now", "",
    "    First subject", "",
    "commit 2222222222222222222222222222222222222222",
    "Author: B <b@x>", "Date: now", "",
    "    Second subject", "",
  ].join("\n");
  const out = compactGit("log", raw, 60);
  assert.match(out, /111111111 First subject/);
  assert.match(out, /222222222 Second subject/);
  assert.doesNotMatch(out, /Author:/, "author/date boilerplate dropped");
});

test("git diff (unified): collapses to a per-file diffstat, drops hunks", () => {
  const raw = [
    "diff --git a/src/A.cpp b/src/A.cpp",
    "index 111..222 100644",
    "--- a/src/A.cpp",
    "+++ b/src/A.cpp",
    "@@ -1,2 +1,3 @@",
    "+added one",
    "+added two",
    "-removed one",
    " context",
  ].join("\n");
  const out = compactGit("diff", raw, 60);
  assert.match(out, /1 file\(s\) changed, \+2 -1:/);
  assert.match(out, /src\/A\.cpp \| \+2 -1/);
  assert.doesNotMatch(out, /@@/, "hunk headers dropped");
});

test("git diff: empty diff", () => {
  assert.equal(compactGit("diff", "", 60), "(no diff).");
});

test("git unknown subcommand: generic dedup+cap (still a win)", () => {
  const raw = ["same", "same", "same", "other"].join("\n");
  const out = compactGit("branch", raw, 60);
  assert.match(out, /same {2}\(×3\)/);
  assert.match(out, /other/);
});

test("p4 opened: groups by action + depot dir", () => {
  const raw = [
    "//depot/game/a.cpp#3 - edit default change (text)",
    "//depot/game/b.cpp#1 - edit default change (text)",
    "//depot/engine/c.h#2 - add default change (text)",
  ].join("\n");
  const out = compactP4("opened", raw, 60);
  assert.match(out, /3 file\(s\):/);
  assert.match(out, /edit: 2/);
  assert.match(out, /add: 1/);
});

test("p4 changes: terse one-line-per-change", () => {
  const raw = [
    "Change 123 on 2026/01/01 by user@ws 'fix the thing'",
    "Change 124 on 2026/01/02 by user@ws 'another'",
  ].join("\n");
  const out = compactP4("changes", raw, 60);
  assert.match(out, /123 2026\/01\/01 user@ws fix the thing/);
  assert.match(out, /124 .* another/);
});
