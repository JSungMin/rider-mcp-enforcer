#!/usr/bin/env node
/*
 * rider-mcp-enforcer — VCS output-compaction CLI. The PreToolUse hook rewrites a single read-only
 * `git status|log|diff` / `p4 opened|status|changes|reconcile` into:
 *
 *   node "<plugin>/proxy/vcs.mjs" <git|p4> <sub> [flags…]
 *
 * It runs the REAL command (so the answer is always correct + current), then groups/dedups/caps the raw
 * stdout via proxy/src/compact.js before it reaches the model. The command always runs — this never blocks.
 *
 * Honesty guards:
 *   - A non-zero exit or empty stdout → print the raw stdout+stderr UNCOMPACTED and exit with the real
 *     status, so a "not a git repo" / auth error surfaces verbatim (never a misleading "clean").
 *   - The binary missing (git/p4 not installed) → print stderr, exit 127.
 * Cap via RIDER_VCS_MAX (default 60). Disable the rewrite entirely with RIDER_COMPACT_VCS=0 (hook side).
 */
import { spawnSync } from "node:child_process";
import { compactGit, compactP4 } from "./src/compact.js";

const [, , bin, ...rest] = process.argv;
const sub = (rest[0] || "").toLowerCase();
const MAX = Math.max(1, parseInt(process.env.RIDER_VCS_MAX || "60", 10) || 60);

if (bin !== "git" && bin !== "p4") {
  process.stderr.write(`vcs.mjs: expected 'git' or 'p4' as the first arg, got '${bin || ""}'.\n`);
  process.exit(2);
}

const r = spawnSync(bin, rest, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.error) {
  // ENOENT etc. — binary not on PATH. Surface it; don't pretend success.
  process.stderr.write(`vcs.mjs: failed to run ${bin}: ${r.error.message}\n`);
  process.exit(127);
}

const raw = r.stdout || "";
const status = r.status ?? 0;

// On failure or empty output, pass the real command output through untouched (honest error surfacing).
if (status !== 0 || !raw.trim()) {
  if (raw) process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(status);
}

const out = bin === "git" ? compactGit(sub, raw, MAX) : compactP4(sub, raw, MAX);

// Per-call savings cue when the win is non-trivial (chars/4 ≈ tokens; same heuristic as the proxy).
const rawTok = Math.round(raw.length / 4), outTok = Math.round(out.length / 4);
const saved = rawTok - outTok;
const footer = saved >= 200 ? `\n✓ Saved ~${saved} tokens here (${bin} ${sub}, compacted vs raw)` : "";

process.stdout.write(out + footer + "\n");
if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr);
process.exit(0);
