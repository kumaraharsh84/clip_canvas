// ─── src/renderer/canvas/layout.js ───────────────────────────────────────────
// Everything you have copied, as one continuous zoomable timeline.
//
//     Year > Month > Day > Hour > Clip
//
// nested as boxes inside boxes, the way the reference nests a repository's
// directories and files. You do not navigate into a level; you fly into it.
//
// THREE DECISIONS DEFINE THE LOOK
//
// 1. ORDER IS TIME ORDER. Children are never sorted by size. A squarified
//    treemap needs size order for its aspect ratios, but size correlates with
//    kind (images are one size, links are tiny, pastes are huge), so sorting by
//    size silently files every image together. The layout is an order-
//    preserving strip treemap instead: months run Jan..Dec, hours 9 AM..10 PM,
//    clips in the order you copied them. A screenshot taken between two text
//    clips sits between them.
//
// 2. BOX SIZE IS DECOUPLED FROM TEXT SIZE. A card's area grows with the SQUARE
//    ROOT of its length, clamped -- 100x the text is 10x the area, and nothing
//    may exceed 8x a typical card. Each card then fits its own text by choosing
//    its own font scale (textlayout.fitCard). Measured on real data, the old
//    area-equals-text rule gave one paste 8% of the canvas and half the clips
//    1.9% between them; this is what makes the archive an even mosaic.
//
// 3. NOTHING IS TRUNCATED, IT IS JUST SMALL UNTIL YOU ZOOM. Every card holds its
//    complete text at its own scale. A floor on that scale, plus a maximum zoom
//    derived from the smallest card, guarantees every clip is actually readable
//    at some zoom level rather than merely present.
// ─────────────────────────────────────────────────────────────────────────────

const { categoryOf, blockOf, mix, rgbCss, BG } = require("./classify");

// Text metrics at font scale 1, in world units. Monospace: see textlayout.js.
const CARD_FONT_PX = 12;
const CARD_LINE_H = 16;
const CARD_CHAR_W = CARD_FONT_PX * 0.6;
const COL_GAP = 10;

// Card sizing.
const BASE_AREA = 260 * 190;    // world area of a typical clip
const TYPICAL_CHARS = 600;      // length that gets exactly BASE_AREA
const MIN_FACTOR = 0.35;        // a one-word clip is still a visible tile
const MAX_FACTOR = 8;           // no clip may dominate the canvas
const IMAGE_FACTOR = 1.15;
const FONT_SCALE_FLOOR = 0.05;  // see clipWeight

const DEPTH = { YEAR: 0, MONTH: 1, DAY: 2, HOUR: 3, CLIP: 4 };

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July",
                    "August", "September", "October", "November", "December"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Tree building ────────────────────────────────────────────────────────────
function buildTree(clips) {
  const root = node("root", "All clips", -1, null, 0, null);
  root.labelLong = "All clips";

  for (const clip of clips) {
    const d = toDate(clip.created_at);
    const t = timeParts(clip, d);

    const y = child(root, "y" + t.year, String(t.year), DEPTH.YEAR, t, t.year);
    const m = child(y, "m" + t.month, MONTH_SHORT[t.month - 1], DEPTH.MONTH, t, t.month);
    const dd = child(m, "d" + t.day, dayLabel(t), DEPTH.DAY, t, t.day);
    const h = child(dd, "h" + t.hour, hourLabel(t.hour), DEPTH.HOUR, t, t.hour);

    const ts = d.getTime() || 0;
    const cat = categoryOf(clip);
    const block = blockOf(clip, cat);

    const leaf = node("c" + clip.id, clip.title || cat.label, DEPTH.CLIP, t, ts, h);
    leaf.clip = clip;
    leaf.ts = ts;
    leaf.timeLabel = clockLabel(d);
    leaf.cat = cat;
    leaf.block = block.css;
    leaf.blockRgb = block.rgb;
    leaf.headerText = clip.title || cat.label;
    // How much of the header a far-away card paints as a "filename" dash.
    leaf.titleFrac = Math.min(1, 0.35 + leaf.headerText.length / 40);
    leaf.weight = clipWeight(clip, cat);
    h.children.push(leaf);
  }

  rollUp(root);
  return root;
}

function node(key, label, depth, time, sortKey, parent) {
  return {
    key, label, labelLong: label, depth, time,
    sortKey: sortKey || 0,
    parent: parent || null,
    children: [], weight: 0, count: 0,
    x: 0, y: 0, w: 0, h: 0,
    hdr: 0, pad: 0, gap: 0,
    clip: null,
  };
}

/**
 * Find-or-create a container. Keys are full paths ("root/y2026/m9/d5/h12"), so
 * the 12 PM of one day is never confused with the 12 PM of another -- which is
 * exactly the bug the old flat "h12" keys had: the current-hour marker lit up
 * the same hour on every day.
 */
function child(parent, localKey, label, depth, t, sortKey) {
  if (!parent._index) parent._index = new Map();
  let c = parent._index.get(localKey);
  if (!c) {
    c = node(parent.key + "/" + localKey, label, depth, t, sortKey, parent);
    c.labelLong = longLabel(depth, t);
    parent.children.push(c);
    parent._index.set(localKey, c);
  }
  return c;
}

/**
 * Sum weights, counts, time span, category counts and average colour bottom-up,
 * and put children in CHRONOLOGICAL order -- never size order (see the header).
 */
function rollUp(n) {
  if (n.clip) {
    n.count = 1;
    n.tsMin = n.tsMax = n.ts;
    return;
  }

  let w = 0;
  let c = 0;
  let tsMin = Infinity;
  let tsMax = -Infinity;
  let r = 0;
  let g = 0;
  let b = 0;
  const cats = {};

  for (const kid of n.children) {
    rollUp(kid);
    w += kid.weight;
    c += kid.count;
    if (kid.tsMin < tsMin) tsMin = kid.tsMin;
    if (kid.tsMax > tsMax) tsMax = kid.tsMax;

    const rgb = kid.clip ? kid.blockRgb : kid.avgRgb;
    r += rgb[0] * kid.weight;
    g += rgb[1] * kid.weight;
    b += rgb[2] * kid.weight;

    if (kid.clip) cats[kid.cat.id] = (cats[kid.cat.id] || 0) + 1;
    else for (const id in kid.cats) cats[id] = (cats[id] || 0) + kid.cats[id];
  }

  n.weight = w;
  n.count = c;
  n.tsMin = tsMin;
  n.tsMax = tsMax;
  n.cats = cats;
  n.avgRgb = w > 0 ? [r / w, g / w, b / w] : BG.slice();
  // A container too small to open is painted as the blend of what is inside
  // it, so even collapsed regions keep the mosaic's colour.
  n.blockColor = rgbCss(mix(n.avgRgb, BG, 0.12));
  n.children.sort((a, b2) => a.sortKey - b2.sortKey);
  delete n._index;
}

// ── Card size ────────────────────────────────────────────────────────────────
/**
 * How much canvas a clip gets.
 *
 * Grows with the square root of its length, clamped to [0.35, 8] x a typical
 * card, so length stays visible without any clip swallowing the canvas.
 *
 * One exception, the readability floor: a card is never made so small that its
 * text would have to shrink below FONT_SCALE_FLOOR to fit. Without it a
 * megabyte paste compressed to 8x a typical card would need its text drawn at
 * ~1% size, readable only at a zoom level nobody reaches.
 */
function clipWeight(clip, cat) {
  const c = cat || categoryOf(clip);
  if (clip.type === "image" || c.id === "image") return BASE_AREA * IMAGE_FACTOR;

  const len = Math.max(1, (clip.content || "").length);
  const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, Math.sqrt(len / TYPICAL_CHARS)));
  const compressed = BASE_AREA * factor;
  // 1.6 covers the card's own header, padding and ragged line ends.
  const floor = len * CARD_CHAR_W * CARD_LINE_H * FONT_SCALE_FLOOR * FONT_SCALE_FLOOR * 1.6;
  return Math.max(compressed, floor);
}

// ── Time helpers ─────────────────────────────────────────────────────────────
/**
 * Clip timestamps to a Date. The clips table stores created_at as INTEGER Unix
 * SECONDS -- passing one straight to `new Date()` dates every clip to 1970.
 * Anything below 1e12 is seconds (1e12 ms is the year 2001).
 */
function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
  const n = Number(value);
  if (value !== "" && value !== null && value !== undefined && !Number.isNaN(n)) {
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  return new Date(value);
}

function timeParts(clip, d) {
  if (clip.year != null && clip.month != null && clip.day != null && clip.hour != null) {
    return { year: clip.year, month: clip.month, day: clip.day, hour: clip.hour };
  }
  const date = d || toDate(clip.created_at);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
  };
}

/** "10:42 PM" -- shown on every clip card so you can see WHEN you copied it. */
function clockLabel(v) {
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return "";
  let h = d.getHours();
  const suffix = h < 12 ? "AM" : "PM";
  h = h % 12 === 0 ? 12 : h % 12;
  return h + ":" + String(d.getMinutes()).padStart(2, "0") + " " + suffix;
}

function hourLabel(h) {
  const base = h % 12 === 0 ? 12 : h % 12;
  return base + (h < 12 ? " AM" : " PM");
}

function weekday(t) {
  return new Date(t.year, t.month - 1, t.day).getDay();
}

function dayLabel(t) {
  return WEEKDAY_SHORT[weekday(t)] + " " + t.day;
}

function longLabel(depth, t) {
  switch (depth) {
    case DEPTH.YEAR: return String(t.year);
    case DEPTH.MONTH: return MONTH_LONG[t.month - 1] + " " + t.year;
    case DEPTH.DAY: return WEEKDAY_LONG[weekday(t)] + " " + t.day + " " + MONTH_LONG[t.month - 1];
    case DEPTH.HOUR: return hourLabel(t.hour) + " – " + hourLabel((t.hour + 1) % 24);
    default: return "";
  }
}

/** Key of the hour container a Date falls in -- for the current-hour marker. */
function hourKey(date) {
  const d = toDate(date);
  return "root/y" + d.getFullYear() + "/m" + (d.getMonth() + 1) +
         "/d" + d.getDate() + "/h" + d.getHours();
}

module.exports = {
  buildTree, clipWeight,
  DEPTH, CARD_FONT_PX, CARD_LINE_H, CARD_CHAR_W, COL_GAP,
  BASE_AREA, MIN_FACTOR, MAX_FACTOR, FONT_SCALE_FLOOR,
  MONTH_SHORT, MONTH_LONG, WEEKDAY_SHORT,
  toDate, clockLabel, hourLabel, dayLabel, hourKey,
};
