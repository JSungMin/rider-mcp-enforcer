// Editor-log analysis for rider-mcp-enforcer.
// Detect UE/Unity/generic editor logs, parse {severity, category, location, message},
// template-dedup repeated spam, and return search/filter-centric, token-capped output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEV_RANK = { Fatal: 5, Error: 4, Warning: 3, Display: 2, Verbose: 1 };
const rank = (s) => SEV_RANK[s] ?? 2;

// ---- detection ----
export function detectLogs(projectPath) {
  const out = [];
  const add = (p) => {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p.replace(/\\/g, "/"));
    } catch {
      /* ignore */
    }
  };
  if (projectPath) {
    // UE: <root>/Saved/Logs, and commonly <root>/<GameDir>/Saved/Logs (the .uproject dir).
    const roots = [projectPath];
    try {
      for (const d of fs.readdirSync(projectPath, { withFileTypes: true }))
        if (d.isDirectory() && !d.name.startsWith(".")) roots.push(path.join(projectPath, d.name));
    } catch {
      /* unreadable root */
    }
    for (const r of roots) {
      const logdir = path.join(r, "Saved", "Logs");
      try {
        for (const f of fs.readdirSync(logdir))
          if (f.toLowerCase().endsWith(".log")) add(path.join(logdir, f));
      } catch {
        /* no Saved/Logs here */
      }
    }
  }
  if (process.env.LOCALAPPDATA)
    add(path.join(process.env.LOCALAPPDATA, "Unity", "Editor", "Editor.log"));
  add(path.join(os.homedir(), "Library", "Logs", "Unity", "Editor.log"));
  // Newest first so the active editor log is the default.
  return [...new Set(out)].sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

// ---- read (tail bytes for huge logs) ----
export function readText(file, maxBytes) {
  const size = fs.statSync(file).size;
  if (!maxBytes || size <= maxBytes) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return "…(older lines truncated)…\n" + buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// ---- parsing ----
function extractLoc(s) {
  const m =
    s.match(/\(at\s+([\w./\\:-]+):(\d+)\)/i) ||
    s.match(/Filename:\s*([\w./\\:-]+)\s+Line:\s*(\d+)/i) ||
    s.match(/([\w./\\:-]+\.[A-Za-z]{1,5})[(:](\d+)/);
  return m ? `${m[1].replace(/\\/g, "/")}:${m[2]}` : "";
}

export function parseLine(line) {
  if (!line || !line.trim()) return null;

  // Build/compile diagnostic: path(line[,col]): error|warning CODE: message  (MSVC/UBT/C#)
  let m = line.match(/^\s*(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(error|warning)\b[^:]*:\s*(.*)$/i);
  if (m) {
    return {
      severity: m[3].toLowerCase() === "error" ? "Error" : "Warning",
      category: "Build",
      location: `${m[1].trim().replace(/\\/g, "/")}:${m[2]}`,
      message: m[4].trim(),
    };
  }

  // UE runtime: [time][frame]Category: [Verbosity: ] message  (frame optional)
  m =
    line.match(
      /^\[[\d.\-:\s]+\]\[\s*\d+\s*\]([A-Za-z][\w]+):\s*(?:(Display|Warning|Error|Fatal|Verbose|VeryVerbose|Log):\s*)?(.*)$/
    ) ||
    line.match(
      /^\[[\d.\-:\s]+\]([A-Za-z][\w]+):\s*(?:(Display|Warning|Error|Fatal|Verbose|VeryVerbose|Log):\s*)?(.*)$/
    );
  if (m) {
    const sev = m[2] && m[2] !== "Log" ? m[2] : "Display";
    return { severity: sev, category: m[1], location: extractLoc(m[3] || ""), message: (m[3] || "").trim() };
  }

  // Unity / generic: detect a severity keyword + optional location.
  // "exception"/"fatal" matched as substrings so glued names (NullReferenceException) count.
  let sev = null;
  if (/(fatal|exception|assert(ion)?\s+failed)/i.test(line)) sev = "Error";
  else if (/(^|\W)(error|fail(ed|ure)?)(\W|$)/i.test(line)) sev = "Error";
  else if (/(^|\W)(warning|warn)(\W|$)/i.test(line)) sev = "Warning";
  if (sev) return { severity: sev, category: "Log", location: extractLoc(line), message: line.trim() };

  return null; // uninteresting info line
}

// Normalize variable parts so repeated spam collapses into one template.
// Numbers are matched WITHOUT a word boundary so instance ids (e.g. "Actor_12",
// "Pawn_07") collapse together with coordinates and counters.
function templateOf(msg) {
  return msg
    .replace(/0x[0-9a-fA-F]+/g, "<addr>")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<guid>")
    .replace(/[A-Za-z]:[\\/][^\s'"]+/g, "<path>")
    .replace(/-?\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

// ---- generic field extraction (columnar "decisive scalars only") ----
// For structured trace logs with `Key=value`, `Key=(x, y, z)`, `Key=(P.. Y.. R..)` fields.
// Pulls just the requested fields into a compact table instead of dumping raw lines —
// the single biggest token win on dense trace logs (often ~99% vs a raw window dump).
function rawField(line, key) {
  const m = line.match(new RegExp(`(?:^|[\\s\\[(,])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(\\([^)]*\\)|[^\\s,)]+)`));
  return m ? m[1] : null;
}
function vecComp(val, idx) {
  if (!val) return null;
  const parts = val.replace(/[()]/g, "").split(",").map((s) => s.trim());
  return parts[idx] ?? null;
}
function rotComp(val, which) {
  if (!val) return null;
  const m = val.match(new RegExp(`${which}(-?\\d+(?:\\.\\d+)?)`));
  return m ? m[1] : null;
}
// Resolve one field spec against a line → string value (or "").
function getField(line, spec) {
  if (spec === "ts") return rawField(line, "ts") ?? rawField(line, "Ts") ?? rawField(line, "time") ?? "";
  let m;
  if ((m = spec.match(/^(.+)\.(x|y|z)$/))) {
    return vecComp(rawField(line, m[1]), { x: 0, y: 1, z: 2 }[m[2]]) ?? "";
  }
  if ((m = spec.match(/^(.+)\.(Y|P|R)$/))) return rotComp(rawField(line, m[1]), m[2]) ?? "";
  return rawField(line, spec) ?? "";
}
const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

export function extractFields(text, opts = {}) {
  const {
    fields = ["ts"],
    query = "",
    category = "",
    file = "",
    severityMin = "Verbose",
    window = null, // [t0, t1] on ts
    max = 200,
    maxLineChars = 200,
  } = opts;
  const minRank = rank(severityMin);
  const q = String(query).toLowerCase();
  const catLc = String(category).toLowerCase();
  const fileLc = String(file).toLowerCase();
  // computed columns reference a base field
  const cols = fields.map((f) => {
    let mm;
    if (f === "dts") return { name: "dts", kind: "dts", base: "ts" };
    if ((mm = f.match(/^d:(.+)$/))) return { name: f, kind: "delta", base: mm[1] };
    if ((mm = f.match(/^step:(.+)$/))) return { name: f, kind: "step", base: mm[1] };
    return { name: f, kind: "value", base: f };
  });

  const rows = [];
  let prev = {};
  for (const raw of text.split(/\r?\n/)) {
    const e = parseLine(raw);
    if (!e) continue;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !raw.toLowerCase().includes(q)) continue;
    if (window) {
      const t = num(getField(raw, "ts"));
      if (t == null || t < window[0] || t > window[1]) continue;
    }
    const row = [];
    const cur = {};
    for (const c of cols) {
      if (c.kind === "value") {
        row.push(getField(raw, c.name));
      } else if (c.kind === "dts") {
        const t = num(getField(raw, "ts"));
        row.push(t != null && prev.ts != null ? (t - prev.ts).toFixed(3) : "");
        cur.ts = t;
      } else if (c.kind === "delta") {
        const v = num(getField(raw, c.base));
        const p = prev["v:" + c.base];
        row.push(v != null && p != null ? (v - p).toFixed(3) : "");
        cur["v:" + c.base] = v;
      } else if (c.kind === "step") {
        const x = num(vecComp(rawField(raw, c.base), 0));
        const y = num(vecComp(rawField(raw, c.base), 1));
        const px = prev["x:" + c.base];
        const py = prev["y:" + c.base];
        row.push(x != null && px != null ? Math.hypot(x - px, y - py).toFixed(2) : "");
        cur["x:" + c.base] = x;
        cur["y:" + c.base] = y;
      }
    }
    // always remember ts + referenced bases for next-row deltas
    if (cur.ts === undefined) cur.ts = num(getField(raw, "ts"));
    for (const c of cols) {
      if (c.kind === "delta" && cur["v:" + c.base] === undefined) cur["v:" + c.base] = num(getField(raw, c.base));
    }
    prev = cur;
    let line = row.join("\t");
    if (line.length > maxLineChars) line = line.slice(0, maxLineChars) + " …";
    rows.push(line);
    if (rows.length >= max) break;
  }
  const header = fields.join("\t");
  const footer = rows.length >= max ? `\n… capped at ${max} rows (narrow window/query/maxGroups).` : "";
  return `${header}\n${rows.join("\n") || "(no matching rows)"}${footer}`;
}

// ---- analyze (search/filter + dedup) ----
export function analyzeLog(text, opts = {}) {
  const {
    query = "",
    severityMin = "Warning",
    category = "",
    file = "",
    maxGroups = 40,
    maxLocs = 5,
    maxLineChars = 200,
    summaryOnly = false,
    groupBy = "template", // "template" (per distinct message) | "callsite" (per file:line)
  } = opts;
  const minRank = rank(severityMin);
  const q = String(query).toLowerCase();
  const catLc = String(category).toLowerCase();
  const fileLc = String(file).toLowerCase();

  const lines = text.split(/\r?\n/);
  let total = 0,
    matched = 0;
  const sevCounts = { Fatal: 0, Error: 0, Warning: 0, Display: 0, Verbose: 0 };
  const catCounts = {};
  const groups = new Map();

  for (const raw of lines) {
    const e = parseLine(raw);
    if (!e) continue;
    total++;
    sevCounts[e.severity] = (sevCounts[e.severity] || 0) + 1;
    catCounts[e.category] = (catCounts[e.category] || 0) + 1;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !e.message.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
    matched++;
    const key =
      groupBy === "callsite" && e.location
        ? `${e.severity}|${e.category}|@${e.location}`
        : `${e.severity}|${e.category}|${templateOf(e.message)}`;
    let g = groups.get(key);
    if (!g) {
      g = { severity: e.severity, category: e.category, message: e.message, count: 0, locs: new Set() };
      groups.set(key, g);
    }
    g.count++;
    if (e.location && g.locs.size < maxLocs) g.locs.add(e.location);
  }

  const header =
    `Log analysis — ${total} classified line(s); matched ${matched} ` +
    `(filter: severity≥${severityMin}${category ? `, category=${category}` : ""}` +
    `${file ? `, file~${file}` : ""}${query ? `, query="${query}"` : ""}).\n` +
    `Severity: Fatal ${sevCounts.Fatal}, Error ${sevCounts.Error}, Warning ${sevCounts.Warning}, ` +
    `Display ${sevCounts.Display}.`;

  if (summaryOnly) {
    const topCats = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([c, n]) => `  ${c}: ${n}`)
      .join("\n");
    return `${header}\n\nTop categories:\n${topCats}`;
  }

  const sorted = [...groups.values()].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || b.count - a.count
  );
  const shown = sorted.slice(0, maxGroups);
  const body = shown
    .map((g) => {
      let msg = g.message;
      if (msg.length > maxLineChars) msg = msg.slice(0, maxLineChars) + " …";
      const loc = g.locs.size ? "  @ " + [...g.locs].join(", ") : "";
      const mult = g.count > 1 ? `  (×${g.count})` : "";
      return `${g.severity.toUpperCase()} [${g.category}] ${msg}${mult}${loc}`;
    })
    .join("\n");
  const more = sorted.length - shown.length;
  const footer =
    (more > 0 ? `\n\n… ${more} more group(s) (raise maxGroups, or filter by severity/category/query).` : "") +
    (matched === 0 ? `\n(no entries matched — lower severityMin or change the filter.)` : "");
  return `${header}\n\n${body || "(no matching entries)"}${footer}`;
}
