// Unit tests for the proxy's pure helpers (node:test). Run: `npm test` from proxy/.
// These lock in the behavior of the summarizer, the build-artifact exclude, and the Windows
// projectPath normalization (the bug that made every Rider search fail on backslash paths).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeProjectPath,
  parseSearch,
  isExcluded,
  itemLine,
  summarize,
  summarizeLines,
  looksLogTarget,
  resolveExistingPath,
  resultSaysMissing,
  staleProjectNote,
  commonDirPrefix,
  factorCommonPrefix,
  symbolHuntInText,
  textSymbolSteer,
  altSymbols,
  usesSteer,
} from "../src/server.js";

const BS = String.fromCharCode(92); // backslash, kept out of source literals to avoid escaping traps

test("normalizeProjectPath converts backslashes to forward slashes", () => {
  assert.equal(normalizeProjectPath(["D:", "Project", "Unreal", "fb"].join(BS)), "D:/Project/Unreal/fb");
  assert.equal(normalizeProjectPath("D:/already/forward"), "D:/already/forward");
  assert.equal(normalizeProjectPath("C:" + BS + "a/" + BS + "b"), "C:/a//b"); // mixed separators
});

test("normalizeProjectPath passes through non-strings untouched", () => {
  assert.equal(normalizeProjectPath(undefined), undefined);
  assert.equal(normalizeProjectPath(null), null);
  assert.equal(normalizeProjectPath(42), 42);
});

test("parseSearch reads the {items, more} shape", () => {
  const r = { content: [{ type: "text", text: JSON.stringify({ items: [{ filePath: "a", startLine: 1 }], more: true }) }] };
  const info = parseSearch(r);
  assert.equal(info.items.length, 1);
  assert.equal(info.more, true);
});

test("parseSearch accepts a bare array as items", () => {
  const r = { content: [{ type: "text", text: JSON.stringify([{ filePath: "a" }, { filePath: "b" }]) }] };
  assert.equal(parseSearch(r).items.length, 2);
  assert.equal(parseSearch(r).more, false);
});

test("parseSearch returns null for non-JSON and non-list payloads", () => {
  assert.equal(parseSearch({ content: [{ type: "text", text: "not json at all" }] }), null);
  assert.equal(parseSearch({ content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] }), null);
  assert.equal(parseSearch({ content: [] }), null);
  assert.equal(parseSearch(null), null);
});

test("isExcluded drops build artifacts but keeps source paths (default exclude list)", () => {
  assert.equal(isExcluded("/proj/Intermediate/x.cpp"), true);
  assert.equal(isExcluded("/proj/Binaries/y.dll"), true);
  assert.equal(isExcluded("/proj/Source/Engine/z.cpp"), false);
});

test("itemLine renders path:line  text and normalizes backslashes", () => {
  const line = itemLine({ filePath: ["a", "b", "C.cpp"].join(BS), startLine: 12, lineText: "  void Foo();  " });
  assert.equal(line, "a/b/C.cpp:12  void Foo();");
});

test("summarize passes non-list responses through untouched", () => {
  const r = { content: [{ type: "text", text: "plain file contents, do not trim" }] };
  assert.deepEqual(summarize(r), r);
});

test("summarize caps at MAX_RESULTS and flags incomplete results", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ filePath: `Source/f${i}.cpp`, startLine: i + 1, lineText: `line ${i}` }));
  const out = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] });
  const text = out.content[0].text;
  // The shared `Source/` dir is factored to a header; rows render as indented relative tails.
  assert.match(text, /^under Source\//m, "common dir prefix is factored into a header");
  const shown = text.split("\n").filter((l) => /^ {2}f\d+\.cpp:\d+/.test(l)).length;
  assert.equal(shown, 50, "should show exactly MAX_RESULTS=50 rows");
  assert.match(text, /INCOMPLETE RESULTS/, "must warn when the list is not exhaustive");
  assert.match(text, /showing 50 of 60/);
});

test("summarize notes hidden build-artifact paths", () => {
  const items = [
    { filePath: "/proj/Source/a.cpp", startLine: 1, lineText: "keep" },
    { filePath: "/proj/Intermediate/b.cpp", startLine: 2, lineText: "drop" },
  ];
  const text = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] }).content[0].text;
  assert.match(text, /build-artifact\/generated path/);
});

test("resultSaysMissing detects rider 'missing path' errors only", () => {
  assert.equal(resultSaysMissing({ content: [{ type: "text", text: "File doesn't exist" }] }), true);
  assert.equal(resultSaysMissing({ content: [{ type: "text", text: "path is not a directory" }] }), true);
  assert.equal(resultSaysMissing({ content: [{ type: "text", text: "cannot find the file" }] }), true);
  assert.equal(resultSaysMissing({ content: [{ type: "text", text: "src/A.cs:1  found it" }] }), false);
  assert.equal(resultSaysMissing(null), false);
});

test("resolveExistingPath resolves on-disk files (absolute + relative-to-project)", () => {
  const tmp = path.join(os.tmpdir(), `rider-regen-${process.pid}-a.cpp`);
  fs.writeFileSync(tmp, "x");
  try {
    assert.equal(resolveExistingPath({ filePath: tmp }), tmp.replace(/\\/g, "/"));
    assert.equal(resolveExistingPath({ pathInProject: path.basename(tmp) }, path.dirname(tmp)), tmp.replace(/\\/g, "/"));
    assert.equal(resolveExistingPath({ paths: [tmp] }), tmp.replace(/\\/g, "/")); // array arg
    assert.equal(resolveExistingPath({ filePath: tmp + ".nope" }), null);
    assert.equal(resolveExistingPath(null), null);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("staleProjectNote fires ONLY when rider says missing AND the file is on disk", () => {
  const tmp = path.join(os.tmpdir(), `rider-regen-${process.pid}-b.cpp`);
  fs.writeFileSync(tmp, "x");
  try {
    const missing = { content: [{ type: "text", text: "doesn't exist" }] };
    const ok = { content: [{ type: "text", text: "Foo.cpp:10  void Foo();" }] };
    assert.match(staleProjectNote(missing, { filePath: tmp }), /Stale project files/);
    assert.match(staleProjectNote(missing, { filePath: tmp }), /rider_regen_project/);
    assert.equal(staleProjectNote(missing, { filePath: tmp + ".nope" }), "", "missing + NOT on disk → genuinely gone, no regen note");
    assert.equal(staleProjectNote(ok, { filePath: tmp }), "", "result not missing → no note even if file exists");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("looksLogTarget flags log paths/files but not source", () => {
  // log dirs + files → true
  assert.equal(looksLogTarget({ path: "G:/Proj/Saved/Logs/Editor.log" }), true);
  assert.equal(looksLogTarget({ pathInProject: "Saved/Logs/run.jsonl" }), true);
  assert.equal(looksLogTarget({ path: ["C:\\P\\Saved\\Logs\\x.log"] }), true); // backslashes + array
  assert.equal(looksLogTarget({ paths: ["a.log", "b.cpp"] }), true); // any element matches
  assert.equal(looksLogTarget({ filePath: "logs/server.log.3" }), true); // rotated
  assert.equal(looksLogTarget({ directory: "x/Logs/" }), true);
  // source / non-log → false
  assert.equal(looksLogTarget({ path: "Source/Engine/Foo.cpp" }), false);
  assert.equal(looksLogTarget({ pathInProject: "src/Bar.cs" }), false);
  assert.equal(looksLogTarget({ path: "Catalog/Item.cs" }), false); // "log" inside "catalog" must NOT match
  assert.equal(looksLogTarget({}), false);
  assert.equal(looksLogTarget(null), false);
});

test("summarize: empty result also steers log lookups to gamedev-log", () => {
  const empty = { content: [{ type: "text", text: JSON.stringify({ items: [] }) }] };
  const out = summarize(empty, { name: "search_regex" }).content[0].text;
  assert.match(out, /lives in LOGS/);
  assert.match(out, /gamedev-log/);
});

test("summarize: a non-trivial win gets a per-call savings line", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    filePath: `Source/f${i}.cpp`,
    startLine: i + 1,
    lineText: `a matched line of code ${i} with enough text that the raw response is big`,
  }));
  const text = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] }).content[0].text;
  assert.match(text, /✓ Saved ~[\d,]+ tok here/);
});

test("summarize: a tiny result gets NO savings footer (no noise)", () => {
  const items = [{ filePath: "Source/a.cpp", startLine: 1, lineText: "x" }];
  const text = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] }).content[0].text;
  assert.doesNotMatch(text, /✓ Saved/);
});

test("summarize: empty result explains the stale-index fallback (not 'symbol missing')", () => {
  const empty = { content: [{ type: "text", text: JSON.stringify({ items: [], more: false }) }] };
  const out = summarize(empty, { name: "search_text" }).content[0].text;
  assert.match(out, /no results/);
  assert.match(out, /index may lag the save/, "must explain the just-edited-file index lag");
  assert.match(out, /Grep on THAT file is the correct fallback/, "must bless grep for the fresh-file case");
  assert.doesNotMatch(out, /symbol search matches DEFINITIONS/, "text tool → no symbol-only hint");
});

test("summarize: empty SYMBOL search also points at the text tools", () => {
  const empty = { content: [{ type: "text", text: JSON.stringify({ items: [] }) }] };
  const out = summarize(empty, { name: "search_symbol" }).content[0].text;
  assert.match(out, /symbol search matches DEFINITIONS/);
  assert.match(out, /search_text \/ search_regex/);
});

test("summarizeLines caps plain text and footnotes the remainder", () => {
  const many = Array.from({ length: 70 }, (_, i) => `row ${i}`).join("\n");
  const out = summarizeLines({ text: many });
  const rows = out.text.split("\n").filter((l) => /^row \d+$/.test(l)).length;
  assert.equal(rows, 50);
  assert.match(out.text, /20 more line\(s\) truncated/);
});

// ---- common-prefix output factoring (ported from vs-token-safer 0.26.4) ----

test("commonDirPrefix finds the longest shared DIR, never counting the filename segment", () => {
  assert.equal(commonDirPrefix(["a/b/c/F.cpp:1", "a/b/c/G.cpp:2"]), "a/b/c");
  assert.equal(commonDirPrefix(["a/b/c/F.cpp:1", "a/b/d/G.cpp:2"]), "a/b");
  // identical dir but the filename differs → the dir is still the prefix (filename never counted)
  assert.equal(commonDirPrefix(["src/F.cpp:1  x", "src/F.cpp:9  y"]), "src");
  assert.equal(commonDirPrefix(["x/F.cpp", "y/G.cpp"]), ""); // no shared dir
  assert.equal(commonDirPrefix(["only/one.cpp"]), ""); // <2 lines
});

test("factorCommonPrefix prints the prefix once with indented relative tails (full path recoverable)", () => {
  const lines = ["G:/P/Source/Game/A.cpp:10  void A();", "G:/P/Source/Game/B.cpp:20  void B();"];
  const out = factorCommonPrefix(lines);
  assert.match(out, /^under G:\/P\/Source\/Game\//);
  assert.match(out, /\n {2}A\.cpp:10 {2}void A\(\);/);
  assert.match(out, /\n {2}B\.cpp:20 {2}void B\(\);/);
  // <prefix>/<tail> reconstructs the original absolute path
  assert.ok(out.includes("under G:/P/Source/Game/\n  A.cpp:10"));
});

test("factorCommonPrefix is a no-op on <2 lines or no shared dir", () => {
  assert.equal(factorCommonPrefix(["solo/F.cpp:1  x"]), "solo/F.cpp:1  x");
  assert.equal(factorCommonPrefix(["x/A.cpp:1", "y/B.cpp:2"]), "x/A.cpp:1\ny/B.cpp:2");
});

test("RIDER_COMPACT_RESULTS=0 restores the classic per-row absolute paths", () => {
  const lines = ["a/b/A.cpp:1", "a/b/B.cpp:2"];
  const prev = process.env.RIDER_COMPACT_RESULTS;
  process.env.RIDER_COMPACT_RESULTS = "0";
  try {
    assert.equal(factorCommonPrefix(lines), "a/b/A.cpp:1\na/b/B.cpp:2");
  } finally {
    if (prev === undefined) delete process.env.RIDER_COMPACT_RESULTS;
    else process.env.RIDER_COMPACT_RESULTS = prev;
  }
});

test("summarize factors the shared root on a real UE-shaped result", () => {
  const items = [
    { filePath: "G:/P/Source/Game/Private/Foo.cpp", startLine: 10, lineText: "void Foo();" },
    { filePath: "G:/P/Source/Game/Private/Bar.cpp", startLine: 20, lineText: "void Bar();" },
  ];
  const text = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] }).content[0].text;
  assert.match(text, /^under G:\/P\/Source\/Game\/Private\//m);
  assert.match(text, /\n {2}Foo\.cpp:10/);
});

// ---- text→symbol steer (ported from vs-token-safer 0.26.0) ----

test("symbolHuntInText extracts the hunted name; null on prose / TODO", () => {
  assert.equal(symbolHuntInText("FindComponentByClass<UMyComp>"), "UMyComp"); // <Type> arg wins
  assert.equal(symbolHuntInText("AActor::BeginPlay"), "BeginPlay"); // longest snake/camel id
  assert.equal(symbolHuntInText("MyManagerClass"), "MyManagerClass"); // CamelCase
  assert.equal(symbolHuntInText("the quick brown fox"), null); // prose
  assert.equal(symbolHuntInText("TODO fix this later"), null); // no symbol-shaped id
  assert.equal(symbolHuntInText("x".repeat(201)), null); // too long
});

test("textSymbolSteer fires on a symbol hunt with a strong cue, names search_symbol, stays honest", () => {
  const note = textSymbolSteer("search_text", { query: "FindComponentByClass<UMyComp>" }, "12 match(es)");
  assert.match(note, /search_symbol q="UMyComp"/);
  assert.match(note, /looks like a symbol/);
  assert.match(note, /can miss on un-indexed/, "must keep Rider's ceiling honest (no completeness claim)");
  assert.doesNotMatch(note, /find_references/, "Rider has no find_references — must not promise it");
});

test("textSymbolSteer fires when the scan was truncated even without a strong cue", () => {
  const note = textSymbolSteer("search_in_files_by_text", { searchText: "MyManagerClass" }, "⚠ INCOMPLETE RESULTS — showing 50 of 200");
  assert.match(note, /search_symbol q="MyManagerClass"/);
  assert.match(note, /not truncated like this scan/);
});

test("textSymbolSteer stays quiet: non-text tools, prose, or a complete CamelCase scan", () => {
  assert.equal(textSymbolSteer("search_symbol", { query: "Foo<Bar>" }, "x"), "", "symbol tool → no steer");
  assert.equal(textSymbolSteer("read_file", { query: "Foo::Bar" }, "x"), "", "non-search tool → no steer");
  assert.equal(textSymbolSteer("search_text", { query: "find the door" }, "x"), "", "prose query → no steer");
  // CamelCase but completed (no strong cue, not truncated) → don't nag
  assert.equal(textSymbolSteer("search_text", { query: "MyManagerClass" }, "3 match(es)"), "");
});

test("RIDER_TEXT_STEER=0 silences the steer", () => {
  const prev = process.env.RIDER_TEXT_STEER;
  process.env.RIDER_TEXT_STEER = "0";
  try {
    assert.equal(textSymbolSteer("search_text", { query: "Foo<Bar>" }, "x"), "");
  } finally {
    if (prev === undefined) delete process.env.RIDER_TEXT_STEER;
    else process.env.RIDER_TEXT_STEER = prev;
  }
});

// ---- alternation steer (ported from vs-token-safer 0.30, #150, retargeted to search_symbol) ----

test("altSymbols parses an N-branch symbol alternation; null on keyword/no-cue", () => {
  assert.deepEqual(altSymbols("getFoo|setBar|resetBaz"), ["getFoo", "setBar", "resetBaz"]); // N=3, general
  assert.deepEqual(altSymbols("get_value|set_value"), ["get_value", "set_value"]); // snake
  assert.deepEqual(altSymbols("Foo|Foo|Bar_baz"), ["Foo", "Bar_baz"]); // deduped, snake cue carries
  assert.equal(altSymbols("TODO|FIXME"), null); // ALL-CAPS keyword → not symbols
  assert.equal(altSymbols("GET|POST|HEAD"), null); // HTTP verbs → not symbols
  assert.equal(altSymbols("a|b"), null); // no CamelCase/snake cue
  assert.equal(altSymbols("MyManagerClass"), null); // no `|`
  assert.equal(altSymbols("Foo|bar baz"), null); // a non-identifier branch → a regex
});

test("textSymbolSteer steers an alternation to search_symbol per branch, regardless of truncation", () => {
  const note = textSymbolSteer("search_text", { query: "GetSyncModeComponent|GetSmoothSyncComponent" }, "8 match(es)");
  assert.match(note, /ALTERNATION of 2 symbols/);
  assert.match(note, /search_symbol q="GetSyncModeComponent"/);
  assert.match(note, /search_symbol q="GetSmoothSyncComponent"/);
  assert.doesNotMatch(note, /find_references/, "Rider has no find_references — must not promise it");
});

test("textSymbolSteer caps an alternation list at 6 shown + a +N more", () => {
  const q = "aCamelOne|bCamelTwo|cCamelThree|dCamelFour|eCamelFive|fCamelSix|gCamelSeven";
  const note = textSymbolSteer("search_text", { query: q }, "x");
  assert.match(note, /ALTERNATION of 7 symbols/);
  assert.match(note, /\(\+1 more\)/);
});

// ---- "where is it USED?" steer (ported from vs-token-safer 0.33, #154, retargeted to search_text) ----

test("usesSteer points a found search_symbol at search_text for references; stays honest", () => {
  const note = usesSteer("search_symbol", { q: "AMyActor" }, "under G:/P/\n  Foo.cpp:10  class AMyActor");
  assert.match(note, /search_text q="AMyActor"/);
  assert.match(note, /DEFINED/);
  assert.match(note, /can miss on un-indexed/);
});

test("usesSteer stays quiet: non-symbol tool, empty result, INCOMPLETE, or a non-identifier query", () => {
  assert.equal(usesSteer("search_text", { q: "AMyActor" }, "hits"), "", "only fires on a symbol tool");
  assert.equal(usesSteer("search_symbol", { q: "AMyActor" }, "(no results)"), "", "nothing found → no point");
  assert.equal(usesSteer("search_symbol", { q: "AMyActor" }, "⚠ INCOMPLETE RESULTS — showing 50 of 200"), "", "partial def set → noise");
  assert.equal(usesSteer("search_symbol", { q: "Foo::Bar" }, "hit"), "", "a phrase/regex, not a single identifier");
});

test("RIDER_USES_STEER=0 silences the uses steer", () => {
  const prev = process.env.RIDER_USES_STEER;
  process.env.RIDER_USES_STEER = "0";
  try {
    assert.equal(usesSteer("search_symbol", { q: "AMyActor" }, "hit"), "");
  } finally {
    if (prev === undefined) delete process.env.RIDER_USES_STEER;
    else process.env.RIDER_USES_STEER = prev;
  }
});

// ---- savings line: shortened wording (ported from vs-token-safer #169) ----

test("summarize emits the shortened savings line ('tok here … vs raw')", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ filePath: `G:/P/Source/F${i}.cpp`, line: i, text: "x".repeat(80) }));
  const text = summarize({ content: [{ type: "text", text: JSON.stringify({ items, more: false }) }] }).content[0].text;
  assert.match(text, /✓ Saved ~[\d,]+ tok here \(Rider index, summarized vs raw\)\./);
  assert.doesNotMatch(text, /tokens here/, "old wording must be gone");
});
