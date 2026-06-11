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
  const shown = text.split("\n").filter((l) => /^Source\/f\d+\.cpp:\d+/.test(l)).length;
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
  assert.match(text, /✓ Saved ~[\d,]+ tokens here/);
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
