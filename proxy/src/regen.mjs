// rider-mcp-enforcer — project-file regeneration helper (the `rider_regen_project` tool's engine).
//
// WHY this exists in a token-saving proxy: a stale Rider project model (new/moved/renamed source since
// the last GenerateProjectFiles) makes the search tools return "doesn't exist"/empty → the model falls
// back to grep → the plugin's whole reason-for-being is defeated. So keeping the index fresh is a
// SEARCH-RELIABILITY feature, not a workflow toy. Stage 1 (server.js staleProjectNote) detects the
// stale signal; this is the one-call fix.
//
// SAFETY (per critic gate). This spawns a multi-minute, side-effecting build tool, and the author can't
// live-test against a real UE install, so the defaults are built to FAIL VISIBLY, never silently-wrong:
//   - DRY-RUN FIRST: a call WITHOUT `confirm:true` never executes — it returns a PLAN (resolved uproject
//     + engine + how it was resolved + the exact command) and stops. Execution always needs an explicit
//     `confirm:true`, even when RIDER_REGEN_CMD is set (config picks WHICH command, not WHETHER to run).
//   - CONCURRENCY LOCK: a lockfile keyed by the uproject path; refuse if a regen is already running
//     (overridable with force:true) so two writers can't corrupt the .sln/.vcxproj.
//   - LAUNCHER → UnrealVersionSelector (it resolves the correct engine ITSELF from EngineAssociation),
//     which sidesteps picking the wrong engine when several are installed.
//   - WINDOWS ONLY for auto-detect; on other platforms it refuses and asks for RIDER_REGEN_CMD rather
//     than constructing an unverified .sh command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

// --- pure helpers (unit-tested) -------------------------------------------------------------------

// Find the project's single .uproject: prefer one directly in `root`, else exactly one in an immediate
// subdir. Ambiguity (several at the same depth, none at root) is an error — never guess.
export function findUproject(root, readdir = defaultReaddir) {
  if (!root) return { error: "No project path. Pass projectPath or set RIDER_PROJECT_PATH." };
  const atRoot = (readdir(root) || []).filter((f) => /\.uproject$/i.test(f));
  if (atRoot.length === 1) return { uproject: path.join(root, atRoot[0]).replace(/\\/g, "/") };
  if (atRoot.length > 1) return { error: `Multiple .uproject files in ${root}: ${atRoot.join(", ")}. Pass projectPath to the exact one.` };
  // none at root → look one level down
  const found = [];
  for (const d of readdir(root) || []) {
    const sub = path.join(root, d);
    let stat;
    try {
      stat = fs.statSync(sub);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of readdir(sub) || []) if (/\.uproject$/i.test(f)) found.push(path.join(sub, f).replace(/\\/g, "/"));
  }
  if (found.length === 1) return { uproject: found[0] };
  if (found.length === 0) return { error: `No .uproject found in ${root} or its immediate subdirs. Pass projectPath.` };
  return { error: `Multiple .uproject candidates: ${found.join(", ")}. Pass projectPath to the exact one.` };
}

function defaultReaddir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

// Read EngineAssociation from a .uproject (JSON). Returns "" if unreadable.
export function readEngineAssociation(uproject, readFile = (p) => fs.readFileSync(p, "utf8")) {
  try {
    const j = JSON.parse(readFile(uproject));
    return typeof j.EngineAssociation === "string" ? j.EngineAssociation.trim() : "";
  } catch {
    return "";
  }
}

// Classify EngineAssociation: a version ("5.3"), a source-build GUID ("{...}"), a path, or empty.
export function classifyEngineAssociation(assoc) {
  const v = String(assoc || "").trim();
  if (!v) return { kind: "empty", value: "" };
  if (/^\{?[0-9A-Fa-f-]{8,}\}?$/.test(v) && /[A-Fa-f-]/.test(v)) return { kind: "guid", value: v.replace(/[{}]/g, "") };
  if (/^\d+(\.\d+)+$/.test(v)) return { kind: "version", value: v };
  if (/[/\\]/.test(v)) return { kind: "path", value: v };
  return { kind: "other", value: v };
}

// Resolve the engine directory. `engineOverride` (RIDER_ENGINE_PATH) wins. Otherwise use the injected
// `regQuery(hive, key, value)` (Windows registry) for launcher (version) / source (GUID) installs.
// Returns { engineDir, buildType, how } or { error }.
export function resolveEngine(assoc, uproject, { engineOverride, regQuery, exists = fs.existsSync } = {}) {
  if (engineOverride) return { engineDir: engineOverride.replace(/\\/g, "/"), buildType: "override", how: "RIDER_ENGINE_PATH" };
  const c = classifyEngineAssociation(assoc);
  if (c.kind === "path") {
    const abs = path.isAbsolute(c.value) ? c.value : path.join(path.dirname(uproject), c.value);
    return { engineDir: abs.replace(/\\/g, "/"), buildType: "source", how: `EngineAssociation path "${c.value}"` };
  }
  if (c.kind === "version") {
    const dir = regQuery && regQuery("HKLM", `SOFTWARE\\EpicGames\\Unreal Engine\\${c.value}`, "InstalledDirectory");
    if (dir) return { engineDir: dir.replace(/\\/g, "/"), buildType: "launcher", how: `registry HKLM EpicGames ${c.value}` };
    return { error: `Could not resolve launcher engine ${c.value} from the registry. Set RIDER_ENGINE_PATH or RIDER_REGEN_CMD.` };
  }
  if (c.kind === "guid") {
    const dir = regQuery && regQuery("HKCU", "Software\\Epic Games\\Unreal Engine\\Builds", c.value);
    if (dir) return { engineDir: dir.replace(/\\/g, "/"), buildType: "source", how: `registry HKCU Builds ${c.value}` };
    return { error: `Could not resolve source-build engine ${c.value} from the registry. Set RIDER_ENGINE_PATH or RIDER_REGEN_CMD.` };
  }
  return { error: `Empty/odd EngineAssociation ("${assoc}"). Set RIDER_ENGINE_PATH or RIDER_REGEN_CMD.` };
}

// Build the regen command (argv). Launcher → UnrealVersionSelector /projectfiles (engine self-resolved).
// Source → GenerateProjectFiles.bat at the engine root. Returns { argv, label } or { error }.
export function buildRegenCommand({ uproject, engineDir, buildType, platform = process.platform, exists = fs.existsSync }) {
  if (platform !== "win32") {
    return { error: "Auto-detect is Windows-only. On macOS/Linux set RIDER_REGEN_CMD to your GenerateProjectFiles.sh invocation." };
  }
  const uvs = path.join(engineDir, "Engine", "Binaries", "Win64", "UnrealVersionSelector.exe");
  // launcher (and override, which we don't know the layout of) → prefer UVS: it resolves the engine itself.
  if ((buildType === "launcher" || buildType === "override") && exists(uvs)) {
    return { argv: [uvs, "/projectfiles", uproject], label: "UnrealVersionSelector /projectfiles" };
  }
  const genBat = path.join(engineDir, "GenerateProjectFiles.bat");
  if (exists(genBat)) {
    return { argv: [genBat, "-project=" + uproject, "-game", "-progress"], label: "GenerateProjectFiles.bat" };
  }
  // last-resort: UBT via Build.bat (flag surface varies by engine version — documented fallback)
  const buildBat = path.join(engineDir, "Engine", "Build", "BatchFiles", "Build.bat");
  if (exists(buildBat)) {
    return { argv: [buildBat, "-projectfiles", "-project=" + uproject, "-game", "-progress"], label: "Build.bat -projectfiles (fallback)" };
  }
  if (exists(uvs)) return { argv: [uvs, "/projectfiles", uproject], label: "UnrealVersionSelector /projectfiles" };
  return { error: `No generator found under ${engineDir} (looked for UnrealVersionSelector.exe, GenerateProjectFiles.bat, Build.bat). Set RIDER_REGEN_CMD.` };
}

// Apply a RIDER_REGEN_CMD template → argv. Splits on whitespace (respecting "double quotes"), then
// substitutes {uproject}/{engine} tokens. The user owns quoting in the template.
export function regenCmdToArgv(template, { uproject, engineDir }) {
  const parts = String(template).match(/"[^"]*"|\S+/g) || [];
  // Strip ALL double-quotes (we exec via argv, not a shell, so quotes would become literal), then sub.
  return parts.map((p) =>
    p.replace(/"/g, "").replace(/\{uproject\}/g, uproject).replace(/\{engine\}/g, engineDir || "")
  );
}

// Pull the lines that look like real errors out of a (possibly huge) build log — UBT errors usually
// appear near the TOP, which a plain tail would bury.
const ERR_MARKER = /\b(error|fatal|unable to find|not found|does not exist|doesn'?t exist|exception|cannot find)\b/i;
export function scanErrors(output, max = 12) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((l) => ERR_MARKER.test(l))
    .slice(0, max);
}

export function tailLines(output, n = 25) {
  const lines = String(output || "").split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

// Post-regen verification (option V): after a confirmed regen, the proxy re-probes Rider for the file
// that was missing. verdict: {visible:true} = Rider sees it now, {visible:false} = still missing, null =
// couldn't check (Rider not connected / probe failed). Turns "did the reload take?" from a guess into a
// checked next step. (Rider exposes no reload trigger, so we can verify but not force the reload.)
export function verifyNote(verifyPath, verdict) {
  if (!verifyPath) return "";
  if (!verdict) {
    return `\n\n(Could not verify ${verifyPath} — Rider isn't connected or the probe failed. After Rider reloads, re-run your search.)`;
  }
  if (verdict.visible) {
    return `\n\n✓ Verified: Rider now sees ${verifyPath} — the reload already took effect; your search / rename_refactoring should resolve it.`;
  }
  return (
    `\n\n✗ Rider still does NOT see ${verifyPath} — it hasn't reloaded the regenerated project yet. ` +
    `Accept Rider's reload prompt (or File → Reload All from Disk / Unreal "Refresh"), then re-run your search.`
  );
}

export function lockPath(configDir, uproject) {
  const h = crypto.createHash("sha1").update(uproject.toLowerCase()).digest("hex").slice(0, 12);
  return path.join(configDir, `regen-${h}.lock`);
}

// --- side-effecting orchestrator (best-effort, integration-light) ---------------------------------

// Windows registry read via `reg query`. Returns the value string or "" (never throws).
export function winRegQuery(hive, key, value) {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync("reg", ["query", `${hive}\\${key}`, "/v", value], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // line: "    InstalledDirectory    REG_SZ    C:\\Program Files\\..."
    const m = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(value.toLowerCase()));
    if (!m) return "";
    const parts = m.split(/\s{2,}|\t/);
    return parts.length >= 3 ? parts.slice(2).join(" ").trim() : "";
  } catch {
    return "";
  }
}

// Plan the regen without running it. ctx supplies config + injectables. Returns { plan } or { error }.
export function planRegen(args, ctx) {
  const root = (args && args.projectPath) || ctx.projectPath || "";
  const uf = findUproject(root, ctx.readdir);
  if (uf.error) return { error: uf.error };
  const uproject = uf.uproject;

  if (ctx.regenCmd) {
    const argv = regenCmdToArgv(ctx.regenCmd, { uproject, engineDir: ctx.engineOverride || "" });
    return { plan: { uproject, engineDir: ctx.engineOverride || "(from RIDER_REGEN_CMD)", how: "RIDER_REGEN_CMD", argv, label: "RIDER_REGEN_CMD", preTrusted: true } };
  }

  const assoc = readEngineAssociation(uproject, ctx.readFile);
  const eng = resolveEngine(assoc, uproject, { engineOverride: ctx.engineOverride, regQuery: ctx.regQuery, exists: ctx.exists });
  if (eng.error) return { error: eng.error };
  const cmd = buildRegenCommand({ uproject, engineDir: eng.engineDir, buildType: eng.buildType, platform: ctx.platform, exists: ctx.exists });
  if (cmd.error) return { error: cmd.error };
  return { plan: { uproject, engineDir: eng.engineDir, how: eng.how, buildType: eng.buildType, argv: cmd.argv, label: cmd.label, preTrusted: false } };
}

function planText(plan, { willRun }) {
  return (
    `Regenerate project files${willRun ? " — RUNNING" : " (DRY RUN — nothing executed)"}:\n` +
    `  project : ${plan.uproject}\n` +
    `  engine  : ${plan.engineDir}  [${plan.how}]\n` +
    `  command : ${plan.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}  (${plan.label})\n` +
    (willRun ? "" : "\nReview the engine + command above. To run it, call rider_regen_project again with confirm:true.")
  );
}

// Full tool entry. Returns an MCP-style { content:[{type:'text',text}], isError? }.
export function regenProject(args = {}, ctx = {}) {
  const c = {
    projectPath: ctx.projectPath || "",
    configDir: ctx.configDir || path.join(os.homedir(), ".rider-mcp-enforcer"),
    regenCmd: ctx.regenCmd || "",
    engineOverride: ctx.engineOverride || "",
    timeoutMs: ctx.timeoutMs || 300000,
    platform: ctx.platform || process.platform,
    regQuery: ctx.regQuery || winRegQuery,
    readdir: ctx.readdir,
    readFile: ctx.readFile,
    exists: ctx.exists || fs.existsSync,
    spawn: ctx.spawn || ((argv, opts) => spawnSync(argv[0], argv.slice(1), opts)),
    now: ctx.now || (() => new Date().toISOString()),
  };
  const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  const planned = planRegen(args, c);
  if (planned.error) return text(`rider_regen_project: ${planned.error}`, true);
  const { plan } = planned;

  // Execute ONLY on explicit confirm — always, even with a pre-set RIDER_REGEN_CMD. The config only
  // decides WHICH command runs, never WHETHER to run; "no confirm" is always a dry run. (This is the
  // dry-run-first safety gate; it also keeps the CLI's "nothing executed" message honest.)
  const willRun = args.confirm === true;
  if (!willRun) return text(planText(plan, { willRun: false }));

  // Concurrency lock: never let two regens write the .sln/.vcxproj at once.
  const lock = lockPath(c.configDir, plan.uproject);
  if (!args.force && c.exists(lock)) {
    return text(
      `rider_regen_project: a regen looks already in progress (lock: ${lock}). If you're sure none is ` +
        `running, delete that file or call again with force:true.`,
      true
    );
  }
  try {
    fs.mkdirSync(c.configDir, { recursive: true });
    fs.writeFileSync(lock, c.now());
  } catch {
    /* best-effort lock */
  }
  let r;
  try {
    r = c.spawn(plan.argv, { encoding: "utf8", timeout: c.timeoutMs, windowsHide: true });
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }

  const out = `${(r && r.stdout) || ""}\n${(r && r.stderr) || ""}`;
  const cmdLine = plan.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  if (r && r.error && r.error.code === "ETIMEDOUT") {
    return text(`rider_regen_project TIMED OUT after ${Math.round(c.timeoutMs / 1000)}s.\n  command: ${cmdLine}\n  engine : ${plan.engineDir}\nRaise RIDER_REGEN_TIMEOUT or run it manually.`, true);
  }
  const code = r ? r.status : null;
  if (code !== 0) {
    const errs = scanErrors(out);
    return text(
      `rider_regen_project FAILED (exit ${code}).\n  command: ${cmdLine}\n  engine : ${plan.engineDir} [${plan.how}]\n` +
        (errs.length ? `  errors :\n    ${errs.join("\n    ")}\n` : "") +
        `  tail   :\n${tailLines(out)}\n` +
        `If the engine above is wrong, set RIDER_ENGINE_PATH or RIDER_REGEN_CMD.`,
      true
    );
  }
  return text(
    `rider_regen_project OK — project files regenerated.\n  command: ${cmdLine}\n  engine : ${plan.engineDir} [${plan.how}]\n` +
      `NEXT: Rider must RELOAD the solution to pick up the new project files before its index updates — ` +
      `accept Rider's reload prompt (it usually detects the .vcxproj change), or do it manually via ` +
      `File → Reload All from Disk (or Unreal "Refresh"). THEN re-run your search / rename_refactoring to ` +
      `confirm the symbol resolves. (Exit 0 means the generator ran, NOT that Rider has re-indexed; if the ` +
      `file is still missing after a reload, the resolved engine above may be wrong.)`
  );
}
