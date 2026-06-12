#!/usr/bin/env node
/*
 * rider-mcp-enforcer — VCS output-compaction CLI. The PreToolUse hook rewrites a single read-only
 * `git status|log|diff` / `p4 opened|status|changes|reconcile` into:
 *
 *   node "<plugin>/proxy/vcs.mjs" <git|p4> <sub> [flags…]
 *
 * It runs the REAL command in the current working directory (git/p4 are cwd-relative), then groups/dedups/
 * caps the raw stdout via proxy/src/compact.js before it reaches the model. The command always runs — this
 * never blocks.
 *
 * Safety (mirrors vs-token-safer): this is a COMPACTION wrapper, NOT an arbitrary-VCS surface.
 *   - Default-DENY to a read-only subcommand allowlist (commit/reset/push/p4 submit/edit/… are refused).
 *   - `git status` is forced to `--porcelain` (long format is prose the compactor can't parse).
 *   - `p4 reconcile` is forced to `-n` (it MUTATES the workspace otherwise) — read-only preview only.
 *   - A benign "nothing here" message (p4 writes these to stderr + nonzero) is an EMPTY result, not a
 *     failure. A genuine failure (binary missing, not a repo) surfaces stdout/stderr verbatim.
 * Cap via RIDER_VCS_MAX (default 60). The hook side disables the whole rewrite with RIDER_COMPACT_VCS=0.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactGit, compactP4 } from "./src/compact.js";

// Record VCS compaction savings into the SAME cumulative ledger the proxy writes, but under a separate
// `vcs` bucket so it never pollutes the Rider-search numbers. Best-effort — never throws.
function recordVcsSavings(rawTok, outTok) {
  try {
    const f = process.env.RIDER_STATS_FILE || path.join(os.homedir(), ".rider-mcp-enforcer", "stats.json");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* fresh ledger */ }
    const v = s.vcs || { calls: 0, rawTokens: 0, sentTokens: 0 };
    v.calls += 1; v.rawTokens += rawTok; v.sentTokens += outTok;
    s.vcs = v;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  } catch { /* best-effort */ }
}

// Default-deny: only these read-only subcommands run. Anything mutating is refused.
const GIT_READONLY = new Set(["status", "log", "diff", "show", "blame", "shortlog", "ls-files", "ls-tree", "describe", "rev-parse", "rev-list", "cat-file", "name-rev", "whatchanged", "reflog", "diff-tree", "cherry", "count-objects"]);
const P4_READONLY = new Set(["opened", "status", "changes", "describe", "filelog", "fstat", "files", "print", "dirs", "diff", "diff2", "where", "info", "annotate", "sizes", "cstat", "reconcile", "have"]);
// p4 (and occasionally git) write a "nothing here" message to STDERR and exit non-zero — that's an EMPTY
// RESULT, not a failure; surfacing it as an error is wrong. Recognize the benign shapes.
const BENIGN_EMPTY = /not opened|no file\(s\)|no files? to|up-to-date|nothing (?:opened|to)|no such file|no changes/i;
const isBenignEmpty = (s) => !!s && BENIGN_EMPTY.test(String(s));

const [, , bin, ...argv0] = process.argv;
const MAX = Math.max(1, parseInt(process.env.RIDER_VCS_MAX || "60", 10) || 60);

if (bin !== "git" && bin !== "p4") {
  process.stderr.write(`vcs.mjs: expected 'git' or 'p4' as the first arg, got '${bin || ""}'.\n`);
  process.exit(2);
}
const argv = argv0.slice();
const sub = String(argv[0] || "").toLowerCase();
if (!sub) {
  process.stderr.write(`vcs.mjs: ${bin} needs a subcommand (e.g. ${bin} status).\n`);
  process.exit(2);
}

// SAFETY: default-deny to read-only subcommands so the wrapper can't run a mutating VCS op.
const allowed = bin === "git" ? GIT_READONLY : P4_READONLY;
if (!allowed.has(sub)) {
  const mut = bin === "git" ? "commit/reset/checkout/clean/push/merge/rebase" : "submit/revert/edit/add/delete";
  process.stderr.write(`vcs.mjs: ${bin} ${sub} is refused — this wrapper runs READ-ONLY ${bin} subcommands only (it just compacts output). Run mutating commands (${mut}) directly with ${bin}.\n`);
  process.exit(2);
}
// `git status` long format is prose; compactGitStatus parses the porcelain `XY path` shape — force it
// (idempotent: leave an explicit -s/--short/--porcelain alone) so a plain `git status` compacts too.
if (bin === "git" && sub === "status" && !argv.some((t) => /^(-s|--short|--porcelain)/.test(t))) argv.push("--porcelain");
// `p4 reconcile` MUTATES the workspace unless previewing — force -n so the wrapper is always read-only.
if (bin === "p4" && sub === "reconcile" && !argv.some((t) => t === "-n" || t === "--preview" || /^-[a-z]*n/i.test(t))) argv.push("-n");

const r = spawnSync(bin, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.error) {
  // ENOENT etc. — binary not on PATH. Surface it; don't pretend success.
  process.stderr.write(`vcs.mjs: failed to run ${bin}: ${r.error.message}\n`);
  process.exit(127);
}
const stdout = r.stdout || "";
const stderr = r.stderr || "";
const code = r.status ?? 0;

if (!stdout.trim() && (code !== 0 || stderr)) {
  // A benign "nothing here" → return cleanly so the agent doesn't read an error where there's no work.
  if (isBenignEmpty(stderr)) {
    process.stdout.write(`(empty) ${bin} ${sub}: ${stderr.trim().slice(0, 200)}\n`);
    process.exit(0);
  }
  // Genuine failure (binary missing, not a repo/workspace, bad args) — surface verbatim.
  if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
  if (stderr) process.stderr.write(stderr);
  process.exit(code || 1);
}

const out = bin === "git" ? compactGit(sub, stdout, MAX) : compactP4(sub, stdout, MAX);

// Per-call savings cue when the win is non-trivial (chars/4 ≈ tokens; same heuristic as the proxy).
const rawTok = Math.round(stdout.length / 4), outTok = Math.round(out.length / 4);
recordVcsSavings(rawTok, outTok); // feed the cumulative ledger so /rider-mcp-enforcer:savings counts VCS too
const saved = rawTok - outTok;
const footer = saved >= 200 ? `\n✓ Saved ~${saved} tokens here (${bin} ${sub}, compacted vs raw)` : "";

process.stdout.write(out + footer + "\n");
if (stderr && stderr.trim()) process.stderr.write(stderr);
process.exit(0);
