// Unit tests for the project-file regeneration helper (regen.mjs). Everything that touches the registry
// or spawns a build is injectable, so these run with no Unreal install. Run: `npm test` from proxy/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findUproject,
  classifyEngineAssociation,
  readEngineAssociation,
  resolveEngine,
  buildRegenCommand,
  regenCmdToArgv,
  scanErrors,
  tailLines,
  planRegen,
  regenProject,
} from "../src/regen.mjs";

const uproot = "C:/Proj";
const UP = "C:/Proj/Game.uproject";

test("findUproject: single at root, multiple at root, none", () => {
  assert.equal(findUproject(uproot, () => ["Game.uproject", "x.txt"]).uproject, "C:/Proj/Game.uproject");
  assert.match(findUproject(uproot, () => ["A.uproject", "B.uproject"]).error, /Multiple .uproject/);
  assert.match(findUproject("", () => []).error, /No project path/);
});

test("classifyEngineAssociation: version / guid / path / empty", () => {
  assert.equal(classifyEngineAssociation("5.3").kind, "version");
  assert.equal(classifyEngineAssociation("{0A1B2C3D-4E5F-6789-ABCD-EF0123456789}").kind, "guid");
  assert.equal(classifyEngineAssociation("0A1B2C3D-4E5F").kind, "guid");
  assert.equal(classifyEngineAssociation("../UnrealEngine").kind, "path");
  assert.equal(classifyEngineAssociation("").kind, "empty");
});

test("readEngineAssociation parses .uproject JSON", () => {
  assert.equal(readEngineAssociation(UP, () => JSON.stringify({ EngineAssociation: "5.3" })), "5.3");
  assert.equal(readEngineAssociation(UP, () => "not json"), "");
});

test("resolveEngine: override wins; version→launcher; guid→source; miss→error", () => {
  assert.equal(resolveEngine("5.3", UP, { engineOverride: "D:/UE" }).engineDir, "D:/UE");
  const launcher = resolveEngine("5.3", UP, { regQuery: (h, k, v) => (h === "HKLM" && v === "InstalledDirectory" ? "C:/UE_5.3" : "") });
  assert.equal(launcher.engineDir, "C:/UE_5.3");
  assert.equal(launcher.buildType, "launcher");
  const source = resolveEngine("{0A1B2C3D-4E5F-6789-ABCD-EF0123456789}", UP, { regQuery: () => "D:/UESource" });
  assert.equal(source.buildType, "source");
  assert.match(resolveEngine("5.3", UP, { regQuery: () => "" }).error, /Could not resolve/);
});

test("buildRegenCommand: launcher→UVS, source→GenerateProjectFiles, non-win32 refuses", () => {
  const uvs = "C:/UE/Engine/Binaries/Win64/UnrealVersionSelector.exe";
  const launcher = buildRegenCommand({ uproject: UP, engineDir: "C:/UE", buildType: "launcher", platform: "win32", exists: (p) => p.replace(/\\/g, "/") === uvs });
  assert.deepEqual(launcher.argv, [uvs.replace(/\//g, path.sep), "/projectfiles", UP].map((x, i) => (i === 0 ? path.join("C:/UE", "Engine", "Binaries", "Win64", "UnrealVersionSelector.exe") : x)));
  const gen = path.join("C:/UE", "GenerateProjectFiles.bat");
  const source = buildRegenCommand({ uproject: UP, engineDir: "C:/UE", buildType: "source", platform: "win32", exists: (p) => p === gen });
  assert.equal(source.argv[0], gen);
  assert.match(source.argv[1], /-project=/);
  assert.match(buildRegenCommand({ uproject: UP, engineDir: "C:/UE", buildType: "launcher", platform: "darwin" }).error, /Windows-only/);
});

test("regenCmdToArgv substitutes tokens and respects quotes", () => {
  assert.deepEqual(
    regenCmdToArgv('"{engine}/gen.bat" -project="{uproject}" -game', { uproject: "C:/P/G.uproject", engineDir: "C:/UE" }),
    ["C:/UE/gen.bat", "-project=C:/P/G.uproject", "-game"]
  );
});

test("scanErrors surfaces error lines; tailLines keeps the end", () => {
  const log = "Building...\nerror: missing symbol\nprogress 50%\nFATAL: boom\nok done";
  assert.deepEqual(scanErrors(log), ["error: missing symbol", "FATAL: boom"]);
  assert.match(tailLines(log, 1), /ok done/);
});

test("planRegen: RIDER_REGEN_CMD is pre-trusted; auto-detect builds a plan", () => {
  const ctx = { projectPath: uproot, readdir: () => ["Game.uproject"], regenCmd: "gen.bat -p={uproject}", engineOverride: "C:/UE" };
  const p1 = planRegen({}, ctx).plan;
  assert.equal(p1.preTrusted, true);
  assert.deepEqual(p1.argv, ["gen.bat", "-p=C:/Proj/Game.uproject"]);

  const auto = planRegen({}, {
    projectPath: uproot,
    readdir: () => ["Game.uproject"],
    readFile: () => JSON.stringify({ EngineAssociation: "5.3" }),
    regQuery: () => "C:/UE_5.3",
    exists: (p) => /UnrealVersionSelector\.exe$/i.test(p),
    platform: "win32",
  }).plan;
  assert.equal(auto.preTrusted, false);
  assert.equal(auto.buildType, "launcher");
  assert.match(auto.label, /UnrealVersionSelector/);
});

test("regenProject: auto-detect is DRY-RUN by default (no spawn)", () => {
  let spawned = false;
  const out = regenProject({}, {
    projectPath: uproot,
    readdir: () => ["Game.uproject"],
    readFile: () => JSON.stringify({ EngineAssociation: "5.3" }),
    regQuery: () => "C:/UE_5.3",
    exists: (p) => /UnrealVersionSelector\.exe$/i.test(p),
    platform: "win32",
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  });
  assert.equal(spawned, false, "dry run must not spawn");
  assert.match(out.content[0].text, /DRY RUN/);
  assert.match(out.content[0].text, /confirm:true/);
});

test("regenProject: confirm:true runs and reports success + re-run advisory", () => {
  const tmpCfg = path.join(os.tmpdir(), `rider-regen-cfg-${process.pid}`);
  let spawned = false;
  const out = regenProject({ confirm: true }, {
    projectPath: uproot,
    configDir: tmpCfg,
    readdir: () => ["Game.uproject"],
    readFile: () => JSON.stringify({ EngineAssociation: "5.3" }),
    regQuery: () => "C:/UE_5.3",
    exists: (p) => /UnrealVersionSelector\.exe$/i.test(p), // lock file does NOT exist → proceeds
    platform: "win32",
    spawn: () => {
      spawned = true;
      return { status: 0, stdout: "Generating...\nDone.", stderr: "" };
    },
  });
  assert.equal(spawned, true);
  assert.match(out.content[0].text, /OK/);
  assert.match(out.content[0].text, /reload/i, "must tell the user Rider has to reload the solution");
  assert.match(out.content[0].text, /re-run your search/i);
  try { fs.rmSync(tmpCfg, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("regenProject: RIDER_REGEN_CMD WITHOUT confirm is still a DRY RUN (config picks the command, not whether to run)", () => {
  let spawned = false;
  const out = regenProject({}, {
    projectPath: uproot,
    readdir: () => ["Game.uproject"],
    regenCmd: "gen.bat -p={uproject}",
    engineOverride: "C:/UE",
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  });
  assert.equal(spawned, false, "no confirm → must not execute even with RIDER_REGEN_CMD");
  assert.match(out.content[0].text, /DRY RUN/);
});

test("regenProject: a non-zero exit surfaces scanned errors, not just a tail", () => {
  const tmpCfg = path.join(os.tmpdir(), `rider-regen-cfg2-${process.pid}`);
  const out = regenProject({ confirm: true }, {
    projectPath: uproot,
    configDir: tmpCfg,
    readdir: () => ["Game.uproject"],
    regenCmd: "gen.bat -p={uproject}", // pre-trusted → runs without confirm too, but confirm given anyway
    engineOverride: "C:/UE",
    exists: () => false, // no lock
    spawn: () => ({ status: 1, stdout: "step1\nerror: Unable to find module X\nstep2", stderr: "" }),
  });
  assert.match(out.content[0].text, /FAILED \(exit 1\)/);
  assert.match(out.content[0].text, /Unable to find module X/);
  assert.equal(out.isError, true);
  try { fs.rmSync(tmpCfg, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("regenProject: refuses when a regen lock is already present (unless force)", () => {
  const out = regenProject({ confirm: true }, {
    projectPath: uproot,
    configDir: os.tmpdir(),
    readdir: () => ["Game.uproject"],
    regenCmd: "gen.bat",
    engineOverride: "C:/UE",
    exists: () => true, // lock present
    spawn: () => ({ status: 0 }),
  });
  assert.match(out.content[0].text, /already in progress/);
  assert.equal(out.isError, true);
});
