// ─── src/renderer/canvas/calendar.js ─────────────────────────────────────────
// Where every day lives. Fixed, like a drawing: a day's place on the canvas
// comes from its date and nothing else.
//
//   year    a box; years sit side by side, anchored at (year - 2000), so a
//           year's position does not depend on which other years exist
//   month   4 x 3 grid inside its year, like a wall calendar
//   day     7-column week grid inside its month, 6 week rows, Sunday first
//
// This is the AutoCAD property the treemap lacked: something at (100, 200)
// stays at (100, 200). Copying a clip cannot move June; searching, filtering
// or switching workspace cannot either -- the camera stays on the same date.
//
// The calendar knows only COUNTS (clips per day per category, from
// db.getDayCounts), which is enough to draw every day of every year as a heat
// cell without loading a single clip. A day's clips are loaded, and laid out
// inside its cell by layout.fillDay, only once you zoom close enough to see
// them (index.js decides when).
//
// Pure: no DOM, so scratch/verify-timecanvas-2d.js checks it on plain Node.
// ─────────────────────────────────────────────────────────────────────────────

const { CATEGORIES, mix, rgbCss, BG } = require("./classify");
const L = require("./layout");

// ── Geometry, in world units ────────────────────────────────────────────────
// A day cell is about one screen at scale 1, which is where clip text becomes
// readable (layout.js card metrics are in the same units).
const EPOCH_YEAR = 2000;
const DAY_W = 1200;
const DAY_H = 900;
const DAY_GAP = 40;
const DAY_HDR = 120;       // band for the day's number and clip count
const DAY_PAD = 24;
const DAY_INNER_GAP = 14;  // between hour boxes inside a day
const WEEK_ROWS = 6;
const MONTH_PAD = 90;
const MONTH_HDR = 620;     // month name: legible when a whole year is on screen
const WEEK_HDR = 200;      // Sun Mon Tue ... row
const MONTH_GAP = 520;
const YEAR_PAD = 520;
const YEAR_HDR = 1700;
const YEAR_GAP = 4200;

const MONTH_W = 2 * MONTH_PAD + 7 * DAY_W + 6 * DAY_GAP;
const MONTH_H = MONTH_HDR + WEEK_HDR + WEEK_ROWS * DAY_H + (WEEK_ROWS - 1) * DAY_GAP + MONTH_PAD;
const YEAR_W = 2 * YEAR_PAD + 4 * MONTH_W + 3 * MONTH_GAP;
const YEAR_H = YEAR_HDR + 3 * MONTH_H + 2 * MONTH_GAP + YEAR_PAD;
const YEAR_STRIDE = YEAR_W + YEAR_GAP;

// COALESCE(category, type) in getDayCounts can hand back a storage type for a
// row the backfill has not reached; map those onto canvas categories.
const TYPE_TO_CATEGORY = { text: "prose", code: "code", url: "url", image: "image", file: "file" };

const dayId = (year, month, day) => year + "-" + month + "-" + day;

// ── Building ─────────────────────────────────────────────────────────────────
/**
 * Calendar for `years` (ascending, contiguous or not). Every day node gets
 * its permanent rect; `root.dayIndex` maps "y-m-d" to it.
 * @param {number[]} years
 * @param {{weekStart?: number, today?: Date}} [opts]
 */
function buildCalendar(years, { weekStart = 0, today = new Date() } = {}) {
  const root = L.node("root", "All clips", -1, null, 0, null);
  root.labelLong = "All clips";
  root.fixed = true;
  root.dayIndex = new Map();
  root.years = years.slice();

  let x0 = Infinity;
  let x1 = -Infinity;
  for (const year of years) {
    const yr = L.node("root/y" + year, String(year), L.DEPTH.YEAR, { year }, year, root);
    place(yr, (year - EPOCH_YEAR) * YEAR_STRIDE, 0, YEAR_W, YEAR_H, YEAR_HDR, YEAR_PAD, MONTH_GAP);
    root.children.push(yr);
    x0 = Math.min(x0, yr.x);
    x1 = Math.max(x1, yr.x + yr.w);

    for (let m = 1; m <= 12; m++) {
      const col = (m - 1) % 4;
      const row = Math.floor((m - 1) / 4);
      const mo = L.node(yr.key + "/m" + m, L.MONTH_SHORT[m - 1], L.DEPTH.MONTH, { year, month: m }, m, yr);
      mo.labelLong = L.MONTH_LONG[m - 1] + " " + year;
      place(mo,
        yr.x + YEAR_PAD + col * (MONTH_W + MONTH_GAP),
        yr.y + YEAR_HDR + row * (MONTH_H + MONTH_GAP),
        MONTH_W, MONTH_H, MONTH_HDR, MONTH_PAD, DAY_GAP);
      mo.weekHdr = WEEK_HDR;
      mo.cellW = DAY_W;
      mo.weekStart = weekStart;
      yr.children.push(mo);

      const lead = (new Date(year, m - 1, 1).getDay() - weekStart + 7) % 7;
      const days = new Date(year, m, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const i = lead + d - 1;
        const t = { year, month: m, day: d, hour: 0 };
        const dn = L.node(mo.key + "/d" + d, L.dayLabel(t), L.DEPTH.DAY, t, d, mo);
        dn.labelLong = L.longLabel(L.DEPTH.DAY, t) + " " + year;
        place(dn,
          mo.x + MONTH_PAD + (i % 7) * (DAY_W + DAY_GAP),
          mo.y + MONTH_HDR + WEEK_HDR + Math.floor(i / 7) * (DAY_H + DAY_GAP),
          DAY_W, DAY_H, DAY_HDR, DAY_PAD, DAY_INNER_GAP);
        dn.dayId = dayId(year, m, d);
        dn.loaded = false;
        mo.children.push(dn);
        root.dayIndex.set(dn.dayId, dn);
      }
    }
  }

  root.x = Number.isFinite(x0) ? x0 : 0;
  root.y = 0;
  root.w = Number.isFinite(x1) ? x1 - root.x : YEAR_W;
  root.h = YEAR_H;
  markFuture(root, today);
  resetCounts(root);
  return root;
}

/**
 * Flag the days after `today`, which are drawn dimmer and never say "nothing
 * copied". Called again when the date changes while the app is open, so the
 * new today stops looking like the future at midnight.
 */
function markFuture(root, today = new Date()) {
  const todayMs = startOfDay(today).getTime();
  for (const d of root.dayIndex.values()) {
    d.future = new Date(d.time.year, d.time.month - 1, d.time.day).getTime() > todayMs;
  }
}

function place(n, x, y, w, h, hdr, pad, gap) {
  n.x = x; n.y = y; n.w = w; n.h = h;
  n.hdr = hdr; n.pad = pad; n.gap = gap;
  n.fixed = true;
}

/**
 * The years a calendar should show for these count rows: from the first year
 * with clips to the last, always including the current year so today exists.
 */
function yearsFor(rows, today = new Date()) {
  let lo = today.getFullYear();
  let hi = lo;
  for (const r of rows) {
    if (r.year < lo) lo = r.year;
    if (r.year > hi) hi = r.year;
  }
  const out = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

// ── Counts ───────────────────────────────────────────────────────────────────
function resetCounts(root) {
  for (const day of root.dayIndex.values()) clearCounts(day);
  rollUpCounts(root);
}

function clearCounts(n) {
  n.count = 0;
  n.cats = {};
  n.tsMin = Infinity;
  n.tsMax = -Infinity;
  n.version = 0;
  n.sig = "0";
  n.avgRgb = BG.slice();
  n.heat = null;
}

/**
 * Apply getDayCounts rows: {year, month, day, category, n, t0, t1, v, dv}.
 * Each day gets its count, per-category counts, time span (ms), a heat colour,
 * and `sig` -- a signature that changes whenever any clip of that day is
 * added, edited, trashed or restored, which is how index.js knows a loaded day
 * went stale.
 */
function applyCounts(root, rows) {
  for (const day of root.dayIndex.values()) clearCounts(day);

  for (const r of rows) {
    const day = root.dayIndex.get(dayId(r.year, r.month, r.day));
    if (!day) continue;
    const cat = CATEGORIES[r.category] ? r.category : TYPE_TO_CATEGORY[r.category] || "code";
    const n = Number(r.n) || 0;
    day.count += n;
    day.cats[cat] = (day.cats[cat] || 0) + n;
    const t0 = toMs(r.t0);
    const t1 = toMs(r.t1);
    if (t0 < day.tsMin) day.tsMin = t0;
    if (t1 > day.tsMax) day.tsMax = t1;
    day.version = Math.max(day.version, Number(r.v) || 0, Number(r.dv) || 0);
  }

  let maxDay = 1;
  for (const day of root.dayIndex.values()) {
    if (!day.count) continue;
    day.sig = day.count + ":" + day.tsMax + ":" + day.version;
    day.avgRgb = catMix(day.cats);
    if (day.count > maxDay) maxDay = day.count;
  }
  // Heat: how full a day was, in the colour of what was copied. sqrt, so a
  // one-clip day is still visibly not-empty next to a hundred-clip day.
  for (const day of root.dayIndex.values()) {
    if (!day.count) continue;
    const k = 0.22 + 0.5 * Math.sqrt(day.count / maxDay);
    day.heat = rgbCss(mix(BG, day.avgRgb, k));
  }
  root.maxDayCount = maxDay;
  rollUpCounts(root);
}

/** Months, years and the root: sums of their days. */
function rollUpCounts(root) {
  (function up(n) {
    if (n.depth === L.DEPTH.DAY) return;
    let count = 0;
    let tsMin = Infinity;
    let tsMax = -Infinity;
    const cats = {};
    for (const k of n.children) {
      up(k);
      count += k.count;
      if (k.tsMin < tsMin) tsMin = k.tsMin;
      if (k.tsMax > tsMax) tsMax = k.tsMax;
      for (const id in k.cats) cats[id] = (cats[id] || 0) + k.cats[id];
    }
    n.count = count;
    n.tsMin = tsMin;
    n.tsMax = tsMax;
    n.cats = cats;
    n.avgRgb = count ? catMix(cats) : BG.slice();
    // Painted when the box is too small to open: the blend of what is inside.
    n.blockColor = count ? rgbCss(mix(n.avgRgb, BG, 0.45)) : null;
  })(root);
}

/** Average block colour of a category mix, weighted by count. */
function catMix(cats) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const id in cats) {
    const c = CATEGORIES[id] || CATEGORIES.code;
    const k = cats[id];
    r += c.blockRgb[0] * k; g += c.blockRgb[1] * k; b += c.blockRgb[2] * k;
    n += k;
  }
  return n ? [r / n, g / n, b / n] : BG.slice();
}

// ── Lookup ───────────────────────────────────────────────────────────────────
function dayNode(root, year, month, day) {
  return root ? root.dayIndex.get(dayId(year, month, day)) || null : null;
}

function dayOf(root, date) {
  const d = L.toDate(date);
  return dayNode(root, d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Unix seconds (created_at) or ms, to ms. */
function toMs(v) {
  const n = Number(v) || 0;
  return n < 1e12 ? n * 1000 : n;
}

module.exports = {
  buildCalendar, yearsFor, applyCounts, resetCounts, markFuture, dayNode, dayOf, dayId,
  GEOMETRY: {
    EPOCH_YEAR, DAY_W, DAY_H, DAY_GAP, DAY_HDR, DAY_PAD, WEEK_ROWS,
    MONTH_W, MONTH_H, MONTH_PAD, MONTH_HDR, WEEK_HDR, MONTH_GAP,
    YEAR_W, YEAR_H, YEAR_PAD, YEAR_HDR, YEAR_GAP, YEAR_STRIDE,
  },
};
