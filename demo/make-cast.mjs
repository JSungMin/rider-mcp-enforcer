// Build an asciinema v2 .cast file WITHOUT asciinema (which isn't available on Windows). Runs the
// same synthetic demo as play.sh, captures the real CLI output, and writes timed terminal events to
// demo/demo.cast. Convert it with a cross-platform tool, no asciinema needed:
//   npx --yes svg-term-cli --in demo/demo.cast --out demo/demo.svg --window      (SVG)
//   agg demo/demo.cast demo/demo.gif                                              (GIF, agg binary)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "gamedev-log-analyzer", "server", "cli.js");
const GEN = path.join(ROOT, "demo", "gen-log.mjs");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "gdlog-cast-"));

const GREEN = "\x1b[1;32m";
const DIM = "\x1b[2;37m";
const RST = "\x1b[0m";
const CRLF = "\r\n";

const events = [];
let t = 0;
const emit = (s) => events.push([Number(t.toFixed(3)), "o", s]);
const wait = (dt) => (t += dt);
const crlf = (s) => s.replace(/\r?\n/g, CRLF);

function say(line) {
  emit(DIM + line + RST + CRLF);
  wait(0.6);
}
function type(cmd) {
  emit(GREEN + "$ " + RST);
  for (const ch of cmd) {
    emit(ch);
    wait(0.02);
  }
  emit(CRLF);
  wait(0.4);
}
function run(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], { cwd: WORK, encoding: "utf8" });
  emit(crlf(out));
  wait(1.0);
}

try {
  say("# gamedev-log-analyzer — read a huge engine log for ~hundreds of tokens, not hundreds of thousands");
  wait(0.3);

  type("node gen-log.mjs 6000 > Editor.log    # synthetic UE-style log");
  const log = execFileSync(process.execPath, [GEN, "6000"], { encoding: "utf8" });
  fs.writeFileSync(path.join(WORK, "Editor.log"), log);
  const bytes = Buffer.byteLength(log, "utf8");
  const lines = log.split("\n").length - 1;
  say(`  ${lines} lines, ${bytes} bytes  (~${Math.round(bytes / 4)} tokens if you paste it raw)`);

  type("gamedev-log summary --path Editor.log");
  run(["summary", "--path", "Editor.log"]);
  const sum = Buffer.byteLength(execFileSync(process.execPath, [CLI, "summary", "--path", "Editor.log"], { cwd: WORK, encoding: "utf8" }), "utf8");
  say(`  ~${Math.round(sum / 4)} tokens — severity counts + top categories, no message bodies.`);

  type("gamedev-log search --path Editor.log --severityMin Error --groupBy callsite");
  run(["search", "--path", "Editor.log", "--severityMin", "Error", "--groupBy", "callsite", "--maxGroups", "8"]);

  type("gamedev-log locate --path Editor.log --severityMin Error --max 6   # jump list");
  run(["locate", "--path", "Editor.log", "--severityMin", "Error", "--max", "6"]);

  const logB = execFileSync(process.execPath, [GEN, "6000", "7"], { encoding: "utf8" });
  fs.writeFileSync(path.join(WORK, "Editor-prev.log"), logB);
  type("gamedev-log diff --pathA Editor-prev.log --pathB Editor.log   # what changed between runs");
  run(["diff", "--pathA", "Editor-prev.log", "--pathB", "Editor.log", "--severityMin", "Warning"]);

  say("# Same engine via MCP in Claude Code, or via npx without an IDE:");
  type("npx -p gamedev-log-analyzer gamedev-log summary --path Editor.log");
  wait(1.5);

  const header = { version: 2, width: 104, height: 32, env: { TERM: "xterm-256color", SHELL: "/bin/bash" } };
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  const outFile = path.join(ROOT, "demo", "demo.cast");
  fs.writeFileSync(outFile, JSON.stringify(header) + "\n" + body + "\n");
  console.log(`wrote ${outFile} — ${events.length} events, ${t.toFixed(1)}s`);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
