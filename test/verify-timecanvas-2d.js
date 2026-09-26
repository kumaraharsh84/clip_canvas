// ─── test/verify-timecanvas-2d.js ─────────────────────────────────────────
// Invariant checks for the canvas-2D Time Canvas (src/renderer/canvas/).
//
// Unlike the other verifiers in this folder, this one runs on PLAIN NODE -- no
// Electron, no database, no window. The layout and text engines are pure
// functions of the clip rows, which is the main reason they were built as
// separate modules: the part that is easy to get silently wrong is the part
// that can be checked headlessly.
//
// Usage:
//   node test/verify-timecanvas-2d.js [--clips=3000] [--seed=1]
//
// Read-only. Touches no database and no file.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const CANVAS = path.join(__dirname, "..", "src", "renderer", "canvas");
const { countLines, wrapLines, cardFlow } = require(path.join(CANVAS, "textlayout.js"));
const L = require(path.join(CANVAS, "layout.js"));
const Cal = require(path.join(CANVAS, "calendar.js"));
const { categoryOf } = require(path.join(CANVAS, "classify.js"));

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const N = Number(flag("clips", 3000));
let seed = Number(flag("seed", 1)) * 1234567 + 89;

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};
const info = (s) => console.log("       " + s);

// ── Deterministic generator ──────────────────────────────────────────────────
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function makeClips(n) {
  const out = [];
  const base = Date.UTC(2026, 0, 1, 9, 0, 0);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const type = r < 0.11 ? "image" : r < 0.38 ? "code" : r < 0.48 ? "url" : "text";
    let content;
    if (type === "image") {
      content = "data:image/png;base64,AAAA";
    } else if (type === "url") {
      content = "https://example.com/" + int(1000, 99999);
    } else {
      // heavy tail -- the case the no-truncation guarantee has to survive
      const len = rnd() < 0.05 ? int(20000, 90000) : int(20, 4000);
      const words = [];
      for (let k = 0; k < len / 6; k++) words.push("w" + int(100, 9999));
      content = words.join(" ");
      if (type === "code") content = content.replace(/(\S+ ){8}/g, "$&\n");
    }
    const d = new Date(base + rnd() * 90 * 86400000);
    out.push({
      id: i + 1, type, content, title: null,
      created_at: d.toISOString(),
      year: d.getFullYear(), month: d.getMonth() + 1,
      day: d.getDate(), hour: d.getHours(),
    });
  }
  return out;
}

// ── 1. The two wrap paths must agree exactly ─────────────────────────────────
// layout reserves space using countLines(); the renderer draws wrapLines().
// If they ever disagree, cards silently clip their own text.
console.log("\n-- countLines agrees with wrapLines --");
let disagree = 0;
for (let i = 0; i < 600; i++) {
  const cols = int(4, 70);
  let s = "";
  const len = int(0, 260);
  for (let k = 0; k < len; k++) {
    const r = rnd();
    s += r < 0.10 ? "\n" : r < 0.28 ? " " : String.fromCharCode(97 + int(0, 25));
  }
  if (countLines(s, cols) !== wrapLines("v" + i, s, cols).length) disagree++;
}
ok("600 random strings agree", disagree === 0, `${disagree} disagreements`);

// ── 2. Wrapping never loses characters, and preserves indentation ────────────
console.log("\n-- wrapping is lossless and indent-preserving --");
const codeSample = "function f() {\n    const xs = items.filter(x => x.enabled && x.ready);\n    return xs;\n}";
const wrapped = wrapLines("code", codeSample, 30);
ok("leading indent survives a wrap", wrapped.some((l) => l.startsWith("    ")), JSON.stringify(wrapped[1]));
ok("no line exceeds the column budget", wrapped.every((l) => l.length <= 30));
const joined = wrapped.join("").replace(/\s/g, "");
ok("no characters invented or dropped", joined === codeSample.replace(/\s/g, ""));

// ── 3. The calendar: every day has a permanent place ─────────────────────────
console.log("\n-- calendar geometry --");
const inside = (a, b, e = 1e-6) =>
  a.x >= b.x - e && a.y >= b.y - e && a.x + a.w <= b.x + b.w + e && a.y + a.h <= b.y + b.h + e;
const overlap = (a, b) =>
  a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const rect = (n) => [n.x, n.y, n.w, n.h].join(",");
const G = Cal.GEOMETRY;

const cal3 = Cal.buildCalendar([2025, 2026, 2027]);
let outside = 0, clash = 0, wrongColumn = 0, tooManyRows = 0, daysSeen = 0;
for (const yr of cal3.children) {
  for (const mo of yr.children) {
    if (!inside(mo, yr)) outside++;
    for (const d of mo.children) {
      daysSeen++;
      if (!inside(d, mo)) outside++;
      const col = Math.round((d.x - mo.x - G.MONTH_PAD) / (G.DAY_W + G.DAY_GAP));
      const wd = new Date(d.time.year, d.time.month - 1, d.time.day).getDay();
      if (col !== (wd - mo.weekStart + 7) % 7) wrongColumn++;
      const row = Math.round((d.y - mo.y - G.MONTH_HDR - G.WEEK_HDR) / (G.DAY_H + G.DAY_GAP));
      if (row >= G.WEEK_ROWS) tooManyRows++;
    }
  }
}
(function check(n) {
  const k = n.children;
  for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (overlap(k[i], k[j])) clash++;
  if (n.depth < L.DEPTH.DAY) k.forEach(check);
})(cal3);
ok("every day of three years is present", daysSeen === 365 + 365 + 365 && cal3.dayIndex.size === daysSeen, `${daysSeen} days`);
ok("days sit inside their month, months inside their year", outside === 0, `${outside} outside`);
ok("no two years, months or days overlap", clash === 0, `${clash} overlaps`);
ok("each day is in its weekday's column", wrongColumn === 0, `${wrongColumn} misplaced`);
ok("no month needs more than six week rows", tooManyRows === 0);

// A day's place comes from its date alone -- not from which years exist.
const cal1 = Cal.buildCalendar([2026]);
let moved = 0;
for (const [id, d] of cal1.dayIndex) if (rect(d) !== rect(cal3.dayIndex.get(id))) moved++;
ok("a day's place does not depend on which years are shown", moved === 0, `${moved} of ${cal1.dayIndex.size} differ`);

// New Year's Eve to 1 January with the app open: the new year's calendar
// appears beside the old one, the old one stays put, and the new today stops
// being drawn as the future.
const eve = new Date(2026, 11, 31, 23, 59);
const jan1 = new Date(2027, 0, 1, 0, 1);
const soFar = [{ year: 2026, month: 12, day: 31 }];
const beforeNY = Cal.buildCalendar(Cal.yearsFor(soFar, eve), { today: eve });
const afterNY = Cal.buildCalendar(Cal.yearsFor(soFar, jan1), { today: jan1 });
let shifted = 0;
for (const [id, d] of beforeNY.dayIndex) if (rect(d) !== rect(afterNY.dayIndex.get(id))) shifted++;
const [y26, y27] = afterNY.children;
ok("on 1 January the new year's calendar appears beside the old one",
   beforeNY.years.join() === "2026" && afterNY.years.join() === "2026,2027" && y27.x > y26.x + y26.w,
   `${beforeNY.years.join()} -> ${afterNY.years.join()}`);
ok("the old year does not move", shifted === 0, `${shifted} of ${beforeNY.dayIndex.size} days moved`);
const open = Cal.buildCalendar([2026, 2027], { today: eve });
const firstDay = open.dayIndex.get("2027-1-1");
const wasFuture = firstDay.future;
Cal.markFuture(open, jan1);
ok("at midnight the new today stops looking like the future",
   wasFuture && !firstDay.future && open.dayIndex.get("2027-1-2").future);

// ── 4. Counts: the calendar without loading a single clip ────────────────────
console.log(`\n-- counts (${N} clips) --`);
const clips = makeClips(N);
const byDay = new Map();
for (const c of clips) {
  const id = Cal.dayId(c.year, c.month, c.day);
  if (!byDay.has(id)) byDay.set(id, []);
  byDay.get(id).push(c);
}
const rows = [];
for (const list of byDay.values()) {
  const per = {};
  for (const c of list) {
    const cat = categoryOf(c).id;
    const t = Math.floor(new Date(c.created_at).getTime() / 1000);
    const r = per[cat] || (per[cat] = { year: c.year, month: c.month, day: c.day, category: cat, n: 0, t0: t, t1: t, v: 0, dv: 0 });
    r.n++; r.t0 = Math.min(r.t0, t); r.t1 = Math.max(r.t1, t);
  }
  rows.push(...Object.values(per));
}
const cal = Cal.buildCalendar(Cal.yearsFor(rows, new Date(2026, 0, 1)));
Cal.applyCounts(cal, rows);
let countOff = 0;
for (const [id, list] of byDay) if (cal.dayIndex.get(id).count !== list.length) countOff++;
ok("every day's count matches its clips", countOff === 0, `${countOff} days off`);
ok("months and years add up", cal.count === N &&
   cal.children.every((y) => y.count === y.children.reduce((a, m) => a + m.count, 0)), `root ${cal.count}`);
ok("days with clips get a heat colour", [...byDay.keys()].every((id) => !!cal.dayIndex.get(id).heat));

// ── 5. Inside a day: time order, full text ───────────────────────────────────
console.log(`\n-- inside each day (${byDay.size} days) --`);
const t0 = Date.now();
const fits = new Map();
for (const [id, list] of byDay) fits.set(id, L.fillDay(cal.dayIndex.get(id), list));
const layoutMs = Date.now() - t0;
info(`${byDay.size} days laid out in ${layoutMs}ms`);

const leaves = [];
const dayOfLeaf = new Map();
for (const id of byDay.keys()) {
  const d = cal.dayIndex.get(id);
  (function walk(n) { if (n.clip) { leaves.push(n); dayOfLeaf.set(n, d); } else n.children.forEach(walk); })(d);
}
ok("every clip is placed", leaves.length === clips.length, `${leaves.length}/${clips.length}`);
ok("every box has positive area", leaves.every((n) => n.w > 0 && n.h > 0));
ok("every card is inside its own day's cell", leaves.every((n) => inside(n, dayOfLeaf.get(n), 1)));

let overlaps = 0;
for (const id of byDay.keys()) {
  (function check(n) {
    const k = n.children;
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (overlap(k[i], k[j])) overlaps++;
    k.forEach(check);
  })(cal.dayIndex.get(id));
}
ok("no two siblings overlap", overlaps === 0, `${overlaps} overlaps`);
ok("layout completes promptly", layoutMs < 4000, `${layoutMs}ms`);

// Clips read in the order they were copied, not grouped by type. If you copied
// text then a screenshot, the screenshot is the next box. Size correlates with
// type, so any size-ordered layout would silently file all the images together.
let outOfOrder = 0, hoursChecked = 0, interleaved = 0, calOut = 0;
for (const id of byDay.keys()) {
  const d = cal.dayIndex.get(id);
  for (let i = 1; i < d.children.length; i++) if (d.children[i].sortKey < d.children[i - 1].sortKey) calOut++;
  for (const h of d.children) {
    hoursChecked++;
    const kids = h.children;
    for (let i = 1; i < kids.length; i++) if (kids[i].ts < kids[i - 1].ts) outOfOrder++;
    for (let i = 1; i < kids.length; i++) if (kids[i].clip.type !== kids[i - 1].clip.type) { interleaved++; break; }
  }
}
ok("every hour is in chronological order", outOfOrder === 0, `${outOfOrder} inversions across ${hoursChecked} hours`);
ok("types are interleaved, not clustered", interleaved > 0, `${interleaved}/${hoursChecked} hours mix types`);
ok("hours run in clock order", calOut === 0, `${calOut} inversions`);
const noLabel = leaves.filter((n) => !n.timeLabel).length;
ok("every clip has a clock label", noLabel === 0, `${noLabel} missing`);
info(`sample: ${leaves.slice(0, 4).map((n) => n.clip.type + "@" + n.timeLabel).join("  ")}`);

// ── 6. THE guarantee: every clip's FULL text fits its card ──────────────────
// Each card chooses its own font scale (textlayout.fitCard), so the check is:
// at the card's OWN scale, does the whole text fit its body? Re-measured here
// from the final geometry, independently of the layout's bookkeeping.
console.log("\n-- every clip holds its complete text at its own font size --");
let over = 0, checked = 0, worst = 0, biggest = 0, maxCols = 1, unreadable = 0;
let minScale = 1;
for (const n of leaves) {
  if (n.clip.type === "image") continue;
  checked++;
  biggest = Math.max(biggest, n.clip.content.length);
  const s = n.fit.scale;
  if (s < minScale) minScale = s;
  // Must mirror what renderer2d draws: multi-column flow at the card's scale.
  const flow = cardFlow(n.clip.content, n.body.w, L.CARD_CHAR_W * s, L.CARD_LINE_H * s, L.COL_GAP * s);
  maxCols = Math.max(maxCols, flow.columns);
  const ratio = flow.neededHeight / n.body.h;
  if (ratio > worst) worst = ratio;
  if (ratio > 1 + 1e-9) over++;
  // Present is not enough: it must be READABLE at the zoom its day allows.
  const zoom = fits.get(dayOfLeaf.get(n).dayId).maxZoom;
  if (L.CARD_FONT_PX * s * zoom < L.READABLE_PX - 1e-9) unreadable++;
}
info(`checked ${checked} text clips · largest ${biggest.toLocaleString()} chars · widest card ${maxCols} columns · worst fit ${worst.toFixed(3)}x`);
ok("NO clip is truncated", over === 0, `${over} would clip their text`);

// Complete is not enough either: the columns must be a shape you can read.
const { MIN_LINES_PER_COL, MAX_COL_CHARS } = require(path.join(CANVAS, "textlayout.js"));
let badShape = 0;
for (const n of leaves) {
  if (n.clip.type === "image") continue;
  const f = n.fit;
  const tooShort = f.columns > 1 && f.linesPerColumn < Math.min(MIN_LINES_PER_COL, f.totalLines);
  // A column a character or two wide is as unreadable as a one-line column.
  const tooNarrow = f.colChars < 12 && n.clip.content.length > f.colChars;
  if (tooShort || tooNarrow || f.colChars > MAX_COL_CHARS) badShape++;
}
ok("every card's columns are readable shapes", badShape === 0,
   `${badShape} with one-line, too-narrow or over-long columns · widest card ${maxCols} columns`);
const worstAspect = Math.max(...leaves.map((n) => Math.max(n.w / n.h, n.h / n.w)));
ok("no sliver-shaped cards", worstAspect <= 30, `worst card aspect ${worstAspect.toFixed(1)}:1`);
ok("every clip is readable at its day's max zoom", unreadable === 0,
   `${unreadable} unreadable · smallest text ${(minScale * 100).toFixed(1)}%`);

// ── 7. The mosaic is even ────────────────────────────────────────────────────
// Card size is sqrt(len) clamped to [MIN_FACTOR, MAX_FACTOR] x a typical card
// -- check that bound holds, except where the readability floor legitimately
// grows a card -- and that no card swallows its day.
console.log("\n-- card sizes stay within the mosaic bound --");
const textLeaves = leaves.filter((n) => n.clip.type !== "image");
const floorOf = (n) =>
  Math.max(1, n.clip.content.length) * L.CARD_CHAR_W * L.CARD_LINE_H * L.FONT_SCALE_FLOOR ** 2 * 1.6;
const floored = textLeaves.filter((n) => floorOf(n) > L.BASE_AREA * L.MAX_FACTOR);
const bounded = textLeaves.filter((n) => !floored.includes(n)).map((n) => n.weight);
const spread = Math.max(...bounded) / Math.min(...bounded);
const limit = L.MAX_FACTOR / L.MIN_FACTOR;
ok("weight spread within the clamp", spread <= limit * 1.0001,
   `max/min ${spread.toFixed(1)}x (limit ${limit.toFixed(1)}x) · ${floored.length} readability-floored`);

let worstShare = 0;
for (const id of byDay.keys()) {
  const d = cal.dayIndex.get(id);
  if (byDay.get(id).length < 20) continue;
  const areas = [];
  (function walk(n) { if (n.clip) areas.push(n.w * n.h); else n.children.forEach(walk); })(d);
  const total = areas.reduce((a, b) => a + b, 0);
  worstShare = Math.max(worstShare, Math.max(...areas) / total);
}
ok("no card dominates a busy day", worstShare < 0.3,
   `largest card ${(worstShare * 100).toFixed(1)}% of its day's cards (days with 20+ clips)`);

// ── 8. A new copy changes only its own day ───────────────────────────────────
// The property the old whole-archive treemap lacked: measured on 5,000 clips,
// one new clip moved all 5,000. Here every day is laid out from its own clips
// alone, so adding one to a day -- and re-laying out EVERY day from scratch,
// the worst case -- must leave every other day's cards exactly where they were.
console.log("\n-- a new copy changes only its own day --");
const snap = new Map(leaves.map((n) => [n.key, rect(n)]));
const busiest = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length)[0];
const [bid, blist] = busiest;
const last = blist[blist.length - 1];
const extra = { ...last, id: clips.length + 1, content: "one more copy", type: "text",
                created_at: new Date(new Date(last.created_at).getTime() + 60000).toISOString() };
byDay.get(bid).push(extra);
const cal2 = Cal.buildCalendar(Cal.yearsFor(rows, new Date(2026, 0, 1)));
for (const [id, list] of byDay) L.fillDay(cal2.dayIndex.get(id), list);
let movedCards = 0, keptCards = 0;
let cellsMoved = 0;
for (const [id, d] of cal.dayIndex) if (rect(d) !== rect(cal2.dayIndex.get(id))) cellsMoved++;
for (const id of byDay.keys()) {
  if (id === bid) continue;
  (function walk(n) {
    if (n.clip) { keptCards++; if (snap.get(n.key) !== rect(n)) movedCards++; return; }
    n.children.forEach(walk);
  })(cal2.dayIndex.get(id));
}
ok("no day cell moved", cellsMoved === 0, `${cellsMoved} moved`);
ok("no card outside the changed day moved", movedCards === 0, `${movedCards} of ${keptCards} moved`);
ok("the new clip landed in its day", !!(function find(n) {
  if (n.clip) return n.clip.id === extra.id;
  return n.children.some(find);
})(cal2.dayIndex.get(bid)));

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
