#!/usr/bin/env node
// One-shot version bumper. Plugin versions live in several files; this keeps them in sync.
//
//   node scripts/bump.mjs <plugin> <level> [--dry-run] [--tag]
//
//   <plugin>  rider | gamedev | both
//   <level>   major | minor | patch   (hotfix and fix are aliases for patch)
//   --dry-run print what would change, write nothing
//   --tag     after writing, create the annotated git tag(s) (rider -> vX.Y.Z, gamedev -> gamedev-vX.Y.Z)
//
// Targets (edited in place, formatting preserved via a scoped regex replace):
//   rider   -> .claude-plugin/plugin.json, .claude-plugin/marketplace.json (rider entry)
//   gamedev -> gamedev-log-analyzer/.claude-plugin/plugin.json,
//              .claude-plugin/marketplace.json (gamedev entry),
//              gamedev-log-analyzer/server/package.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [pluginArg, levelArg] = args.filter((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");
const TAG = flags.has("--tag");

const LEVEL = { major: "major", minor: "minor", patch: "patch", hotfix: "patch", fix: "patch" }[levelArg];
const PLUGINS = pluginArg === "both" ? ["rider", "gamedev"] : [pluginArg];
if (!LEVEL || !["rider", "gamedev", "both"].includes(pluginArg)) {
  console.error("usage: node scripts/bump.mjs <rider|gamedev|both> <major|minor|patch|hotfix> [--dry-run] [--tag]");
  process.exit(2);
}

// Each plugin: the file that holds the canonical version, plus every place to rewrite. A target is
// { file, find } where `find` captures (prefix)(version)(suffix) so we can swap only the version.
const VERSION_RE = String.raw`"version":\s*"([0-9]+\.[0-9]+\.[0-9]+)"`;
const entryVersionRe = (name) => new RegExp(`("name":\\s*"${name}"[\\s\\S]*?"version":\\s*")([0-9]+\\.[0-9]+\\.[0-9]+)(")`);
const topVersionRe = () => new RegExp(`("version":\\s*")([0-9]+\\.[0-9]+\\.[0-9]+)(")`);

const CONFIG = {
  rider: {
    tagPrefix: "v",
    canonical: ".claude-plugin/plugin.json",
    targets: [
      { file: ".claude-plugin/plugin.json", re: topVersionRe() },
      { file: ".claude-plugin/marketplace.json", re: entryVersionRe("rider-mcp-enforcer") },
    ],
  },
  gamedev: {
    tagPrefix: "gamedev-v",
    canonical: "gamedev-log-analyzer/.claude-plugin/plugin.json",
    targets: [
      { file: "gamedev-log-analyzer/.claude-plugin/plugin.json", re: topVersionRe() },
      { file: ".claude-plugin/marketplace.json", re: entryVersionRe("gamedev-log-analyzer") },
      { file: "gamedev-log-analyzer/server/package.json", re: topVersionRe() },
    ],
  },
};

function bumpSemver(v, level) {
  const [maj, min, pat] = v.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function readCurrent(file, re) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const m = text.match(re);
  if (!m) throw new Error(`no version found in ${file}`);
  return m[2]; // capture group 2 is the version in both regex shapes
}

const tagsToMake = [];
for (const plugin of PLUGINS) {
  const cfg = CONFIG[plugin];
  const current = readCurrent(cfg.canonical, topVersionRe());
  const next = bumpSemver(current, LEVEL);
  console.log(`\n${plugin}: ${current} -> ${next} (${LEVEL})`);
  for (const { file, re } of cfg.targets) {
    const abs = path.join(ROOT, file);
    const text = fs.readFileSync(abs, "utf8");
    const found = readCurrent(file, re);
    if (found !== current) {
      console.warn(`  ! ${file} had ${found}, expected ${current} — bumping it to ${next} anyway`);
    }
    const updated = text.replace(re, (_m, p1, _v, p3) => `${p1}${next}${p3}`);
    if (updated === text) throw new Error(`failed to update version in ${file}`);
    if (DRY) {
      console.log(`  would update ${file}`);
    } else {
      fs.writeFileSync(abs, updated);
      console.log(`  updated ${file}`);
    }
  }
  tagsToMake.push({ tag: `${cfg.tagPrefix}${next}`, plugin, next });
}

if (DRY) {
  console.log("\n(dry run — no files written)");
  process.exit(0);
}

if (TAG) {
  for (const { tag, plugin, next } of tagsToMake) {
    execFileSync("git", ["tag", "-a", tag, "-m", `${plugin} ${next}`], { cwd: ROOT, stdio: "inherit" });
    console.log(`tagged ${tag}`);
  }
  console.log("\nPush tags with: git push origin " + tagsToMake.map((t) => t.tag).join(" "));
} else {
  console.log("\nNext: commit the bump, then tag a release, e.g.:");
  for (const { tag } of tagsToMake) console.log(`  git tag -a ${tag} -m "..." && git push origin ${tag}`);
}
