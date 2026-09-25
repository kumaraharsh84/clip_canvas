// ─── scratch/verify-timecanvas-2d.js ─────────────────────────────────────────
// Invariant checks for the canvas-2D Time Canvas (src/renderer/canvas/).
//
// Unlike the other verifiers in this folder, this one runs on PLAIN NODE -- no
// Electron, no database, no window. The layout and text engines are pure
// functions of the clip rows, which is the main reason they were built as
// separate modules: the part that is easy to get silently wrong is the part
// that can be checked headlessly.
//
// Usage:
//   node scratch/verify-timecanvas-2d.js [--clips=3000] [--seed=1]
//
// Read-only. Touches no database and no file.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const CANVAS = path.join(__dirname, "..", "src", "renderer", "canvas");
const { countLines, wrapLines, cardFlow } = require(path.join(CANVAS, "textlayout.js"));
const L = require(path.join(CANVAS, "layout.js"));

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

// ── 3. Treemap geometry ──────────────────────────────────────────────────────
console.log(`\n-- treemap geometry (${N} clips) --`);
const clips = makeClips(N);
const tree = L.buildTree(clips);
const t0 = Date.now();
const res = L.layoutAuto(tree, { aspect: 1.6 });
const layoutMs = Date.now() - t0;
info(`canvas ${Math.round(tree.w)}x${Math.round(tree.h)} · ${res.iterations} passes · ${layoutMs}ms`);

const leaves = [];
(function walk(n) { if (n.clip) leaves.push(n); else n.children.forEach(walk); })(tree);
ok("every clip is placed", leaves.length === clips.length, `${leaves.length}/${clips.length}`);
ok("every box has positive area", leaves.every((n) => n.w > 0 && n.h > 0));
ok("every box is inside the canvas", leaves.every((n) =>
  n.x >= tree.x - 1 && n.y >= tree.y - 1 &&
  n.x + n.w <= tree.x + tree.w + 1 && n.y + n.h <= tree.y + tree.h + 1));

let overlaps = 0;
(function check(n) {
  const k = n.children;
  for (let i = 0; i < k.length; i++)
    for (let j = i + 1; j < k.length; j++) {
      const a = k[i], b = k[j];
      if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
          a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) overlaps++;
    }
  k.forEach(check);
})(tree);
ok("no two siblings overlap", overlaps === 0, `${overlaps} overlaps`);
ok("layout completes promptly", layoutMs < 4000, `${layoutMs}ms`);

// ── 3b. Clips read in the order they were copied ─────────────────────────────
// Not grouped by type. If you copied text then a screenshot, the screenshot is
// the next box. Size correlates with type, so any size-ordered treemap would
// silently file all the images together -- this is the check that catches that.
console.log("\n-- clips are in copy order, not grouped by type --");
let outOfOrder = 0, hoursChecked = 0, interleaved = 0;
(function walk(n) {
  if (n.depth === 3) {
    hoursChecked++;
    const kids = n.children;
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].ts < kids[i - 1].ts) outOfOrder++;
    }
    // did any hour actually mix types adjacently? (proves we are not grouping)
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].clip.type !== kids[i - 1].clip.type) { interleaved++; break; }
    }
    return;
  }
  n.children.forEach(walk);
})(tree);
ok("every hour is in chronological order", outOfOrder === 0, `${outOfOrder} inversions across ${hoursChecked} hours`);
ok("types are interleaved, not clustered", interleaved > 0, `${interleaved}/${hoursChecked} hours mix types`);

// containers must run in calendar order too
let calOut = 0;
(function walk(n) {
  for (let i = 1; i < n.children.length; i++) {
    if (n.children[i].sortKey < n.children[i - 1].sortKey) calOut++;
  }
  n.children.forEach(walk);
})(tree);
ok("months/days/hours run in calendar order", calOut === 0, `${calOut} inversions`);

// every clip carries a readable clock label
const noLabel = leaves.filter((n) => !n.timeLabel).length;
ok("every clip has a clock label", noLabel === 0, `${noLabel} missing`);
info(`sample: ${leaves.slice(0, 4).map((n) => n.clip.type + "@" + n.timeLabel).join("  ")}`);

// ── 4. THE guarantee: every clip's FULL text fits its card ──────────────────
// Each card now chooses its own font scale (textlayout.fitCard), so the check
// is: at the card's OWN scale, does the whole text fit its body? Re-measured
// here from the final geometry, independently of the layout's bookkeeping.
console.log("\n-- every clip holds its complete text at its own font size --");
let over = 0, checked = 0, worst = 0, biggest = 0, maxCols = 1, minScale = 1;
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

// Present is not enough: it must be READABLE at some zoom the viewport allows.
const readablePx = L.CARD_FONT_PX * minScale * res.maxZoom;
ok("every clip is readable at max zoom", readablePx >= L.READABLE_PX - 1e-9,
   `smallest text ${(minScale * 100).toFixed(1)}% · max zoom ${res.maxZoom.toFixed(1)}x · ${readablePx.toFixed(1)}px`);

// ── 5. The mosaic is even ────────────────────────────────────────────────────
// What made the old canvas look nothing like the reference: area was linear in
// text length, so one paste owned 8% of the canvas. Card size is now sqrt(len)
// clamped to [MIN_FACTOR, MAX_FACTOR] x a typical card -- check that bound
// holds, except where the readability floor legitimately grows a card.
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

const areas = leaves.map((n) => n.w * n.h).sort((a, b) => b - a);
const totalArea = areas.reduce((a, b) => a + b, 0);
const top1 = 100 * areas[0] / totalArea;
const topPct = 100 * areas.slice(0, Math.ceil(areas.length / 100)).reduce((a, b) => a + b, 0) / totalArea;
info(`largest card ${top1.toFixed(2)}% of canvas · largest 1% of cards ${topPct.toFixed(1)}%`);
ok("no card dominates the canvas", top1 < 5, `${top1.toFixed(2)}% (was 8.0% under area-equals-text)`);

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
