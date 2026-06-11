#!/usr/bin/env node
/*
 * rider-mcp-enforcer `discover` CLI — scan local Claude Code transcripts and report, in aggregate, how
 * many code searches bypassed rider-search vs went through it. You run it (no MCP / no shell-approval).
 *
 *   node discover.mjs                 # current project, all its sessions
 *   node discover.mjs --since 7       # only sessions touched in the last 7 days
 *   node discover.mjs --all           # every project (cross-project AGGREGATE only — no per-project paths)
 *   node discover.mjs --session <file.jsonl>
 *
 * Reads transcripts only; writes/transmits nothing; prints aggregate counts + coarse token estimates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { makeAnalyzer, classifyBypassRider, isCapturedRider, formatRiderReport } from "./src/discover.mjs";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : "";
};
const sinceDays = Number(valOf("--since")) || 0;
const sessionArg = valOf("--session");
// Claude Code encodes the project dir name from the cwd by replacing : / \ with "-".
const encodeCwd = (p) => p.replace(/[:\\/]/g, "-");

function listTranscripts() {
  if (sessionArg) return [sessionArg];
  const dirs = [];
  if (has("--all")) {
    try {
      for (const d of fs.readdirSync(PROJECTS)) {
        const sub = path.join(PROJECTS, d);
        try {
          if (fs.statSync(sub).isDirectory()) dirs.push(sub);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no projects dir */
    }
  } else {
    dirs.push(path.join(PROJECTS, encodeCwd(process.cwd())));
  }
  const files = [];
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/\.jsonl$/i.test(f)) continue;
      const fp = path.join(dir, f);
      if (cutoff) {
        try {
          if (fs.statSync(fp).mtimeMs < cutoff) continue;
        } catch {
          continue;
        }
      }
      files.push(fp);
    }
  }
  return files;
}

async function run() {
  const files = listTranscripts();
  if (!files.length) {
    console.log(
      `rider discover: no transcripts found under ${PROJECTS} for ${has("--all") ? "any project" : "this project"}` +
        `${sinceDays ? ` in the last ${sinceDays} day(s)` : ""}. Nothing to analyze.`
    );
    return;
  }
  const analyzer = makeAnalyzer({ classifyBypass: classifyBypassRider, isCaptured: isCapturedRider });
  for (const fp of files) {
    await new Promise((resolve) => {
      let stream;
      try {
        stream = fs.createReadStream(fp, { encoding: "utf8" });
      } catch {
        return resolve();
      }
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          return;
        }
        analyzer.feed(rec);
      });
      rl.on("close", resolve);
      rl.on("error", resolve);
      stream.on("error", resolve);
    });
  }
  const scope = sessionArg ? "one session" : has("--all") ? "all projects" : "this project";
  console.log(formatRiderReport(analyzer.result(), { scope }));
}

run();
