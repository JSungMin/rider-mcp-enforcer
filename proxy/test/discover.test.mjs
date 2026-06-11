// Unit tests for the discover analyzer (src/discover.mjs). Synthetic JSONL only — no real transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeJsonl, contentLen, formatRiderReport, classifyBypassRider, isCapturedRider } from "../src/discover.mjs";

// Build a JSONL transcript from compact event specs.
const use = (id, name, input) => ({ message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id, content, is_error) => ({ message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] } });
const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join("\n");

test("contentLen normalizes string and array (text blocks) content", () => {
  assert.equal(contentLen("hello"), 5);
  assert.equal(contentLen([{ type: "text", text: "ab" }, { type: "image" }, { type: "text", text: "cde" }]), 5);
  assert.equal(contentLen(null), 0);
  assert.equal(contentLen(42), 0);
});

test("classifiers reuse the hook detectors (code bypass vs captured vs neither)", () => {
  assert.equal(classifyBypassRider("Bash", { command: "grep -n Foo src/A.cpp" }), "bash");
  assert.equal(classifyBypassRider("Grep", { pattern: "Foo", glob: "*.cs" }), "grep");
  assert.equal(classifyBypassRider("Bash", { command: "grep warning build.log" }), null); // log, not code
  assert.equal(classifyBypassRider("Grep", { pattern: "x" }), null); // bare cwd
  assert.equal(isCapturedRider("mcp__plugin_rider-mcp-enforcer_rider-search__search_symbol"), true);
  assert.equal(isCapturedRider("Bash"), false);
});

test("analyze: counts bypass (at result) + captured (at use), measures output chars", () => {
  const t = jsonl(
    use("a", "Bash", { command: "grep -rn Foo src/" }),
    res("a", "x".repeat(4000)), // 4000 chars ≈ 1K tok
    use("b", "Grep", { pattern: "Bar", type: "csharp" }),
    res("b", "y".repeat(8000)),
    use("c", "mcp__plugin_rider-mcp-enforcer_rider-search__search_symbol", { q: "Foo" }),
    res("c", "result"),
  );
  const r = analyzeJsonl(t);
  assert.equal(r.bypass.bash.count, 1);
  assert.equal(r.bypass.bash.outChars, 4000);
  assert.equal(r.bypass.grep.count, 1);
  assert.equal(r.capturedCount, 1);
  const out = formatRiderReport(r);
  assert.match(out, /bypassed rider-search : 2/);
  assert.match(out, /coverage 33%/); // 1 captured / 3 total
  assert.match(out, /~3K tok/); // (4000+8000)/4/1000 = 3
});

test("analyze: an is_error result is NOT counted (errored read didn't dump output)", () => {
  const t = jsonl(use("a", "Bash", { command: "grep -rn Foo src/" }), res("a", "z".repeat(9999), true));
  const r = analyzeJsonl(t);
  assert.equal(r.bypass.bash, undefined, "errored result must not tally");
});

test("M5: non-empty transcript with zero recognizable tool_use → format-not-recognized, not '0 efficient'", () => {
  const t = jsonl({ some: "other" }, { weird: "line" }, { message: { content: "not an array" } });
  const r = analyzeJsonl(t);
  assert.equal(r.recognized, 0);
  assert.match(formatRiderReport(r), /format not recognized/);
});

test("empty in-domain → 'nothing to report' (not a fake savings number)", () => {
  const t = jsonl(use("a", "Read", { file_path: "notes.txt" }), res("a", "hi"));
  assert.match(formatRiderReport(analyzeJsonl(t)), /no in-domain code searches/);
});

test("M2 sanitization gate: the report leaks NONE of the proprietary tokens in the transcript", () => {
  // A transcript whose commands/paths carry secret project + symbol names.
  const SECRETS = ["TopSecretProj", "Source/Hush/ClassifiedActor.cpp", "DropAllItems", "AcmeCorpInternal"];
  const t = jsonl(
    use("a", "Bash", { command: `grep -rn ${SECRETS[2]} ${SECRETS[1]}` }),
    res("a", `${SECRETS[3]} match in ${SECRETS[1]}: void ${SECRETS[2]}()`.repeat(50)),
    use("b", "Grep", { pattern: SECRETS[2], glob: "*.cpp", path: SECRETS[1] }),
    res("b", "x".repeat(2000)),
  );
  const out = formatRiderReport(analyzeJsonl(t), { scope: "this project" });
  for (const s of SECRETS) {
    assert.ok(!out.includes(s), `report must NOT contain proprietary token "${s}"`);
  }
  // it still produced a useful aggregate
  assert.match(out, /bypassed rider-search : 2/);
});
