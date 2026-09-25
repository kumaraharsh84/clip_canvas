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

const { fitCard } = require("./textlayout");
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
const CHROME_ALLOWANCE = 1.22;  // headers, padding and gaps across four levels
const READABLE_PX = 7;          // body font size that counts as readable

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

// ── Layout ───────────────────────────────────────────────────────────────────
/**
 * Lay the whole tree out on a canvas of the given aspect, then fit every card's
 * text. One pass: because text now scales to its box, no box ever has to be
 * grown to fit its text, so the fixed-point loop the old layout needed is gone.
 */
function layoutAuto(root, { aspect = 1.6, origin = { x: 0, y: 0 } } = {}) {
  const area = Math.max(1, root.weight) * CHROME_ALLOWANCE;
  const w = Math.sqrt(area * aspect);
  root.x = origin.x;
  root.y = origin.y;
  root.w = w;
  root.h = area / w;

  layoutNode(root);

  let minFontScale = 1;
  let worst = 0;
  let failed = 0;
  (function walk(n) {
    if (n.clip) {
      if (!n.fit) return;
      if (n.fit.scale < minFontScale) minFontScale = n.fit.scale;
      const r = n.fit.neededHeight / n.body.h;
      if (r > worst) worst = r;
      if (!n.fit.fits) failed++;
      return;
    }
    for (const kid of n.children) walk(kid);
  })(root);

  // Deep enough that the smallest text on the canvas can be read.
  const maxZoom = Math.min(600, Math.max(8, READABLE_PX / (CARD_FONT_PX * minFontScale)));

  return { root, area, iterations: 1, worstOverflow: worst, minFontScale, maxZoom, failed };
}

function layoutNode(n) {
  chrome(n);
  const inner = {
    x: n.x + n.pad,
    y: n.y + n.hdr,
    w: Math.max(1, n.w - 2 * n.pad),
    h: Math.max(1, n.h - n.hdr - n.pad),
  };

  if (n.clip) {
    n.body = inner;
    n.fit = n.clip.type === "image"
      ? null
      : fitCard(n.clip.content || "", inner.w, inner.h, CARD_CHAR_W, CARD_LINE_H, COL_GAP);
    return;
  }

  if (!n.children.length) return;

  stripLayout(n.children, inner, n.gap);
  for (const kid of n.children) layoutNode(kid);
}

/** A node's weight for the purpose of sharing space among its siblings. */
function lw(n) {
  return n.lw !== undefined ? n.lw : n.weight;
}

/**
 * Header, padding and gap for a box, proportional to the box itself.
 *
 * Fixed-size chrome is what the reference avoids: its labels are small text in
 * the corner of each box, legible once that box fills your screen. Scaling the
 * header with the box gives the same behaviour -- a year's title is readable at
 * the full-archive view, an hour's once you have flown to that day -- and it
 * stays a few percent of the box at every level instead of swamping small ones.
 */
function chrome(n) {
  const size = Math.sqrt(Math.max(1, n.w * n.h));
  if (n.depth < 0) {
    n.hdr = size * 0.004;
    n.pad = size * 0.004;
    n.gap = size * 0.004;
  } else if (!n.clip) {
    n.hdr = Math.max(6, size * 0.024);
    n.pad = n.hdr * 0.28;
    n.gap = n.hdr * 0.22;
  } else {
    // Proportional to the card, but never more than ~6 lines of the card's own
    // text. A big card holds a long clip at a small font, and a header scaled
    // to the card alone dwarfed that text when zoomed in. The cap is loose on
    // purpose: at 2.4 lines most headers became unreadable strips at hour zoom,
    // and the clock time on each card is the point of a time canvas. The drawn
    // band is capped separately, in screen pixels (renderer2d.drawCardHeader).
    const len = Math.max(1, (n.clip.content || "").length);
    const textScale = n.clip.type === "image"
      ? 1
      : Math.min(1, Math.sqrt((n.w * n.h * 0.85) / (len * CARD_CHAR_W * CARD_LINE_H)));
    const cap = Math.max(12, CARD_LINE_H * textScale * 6);
    n.hdr = Math.max(3, Math.min(size * 0.08, cap));
    n.pad = Math.max(1.2, size * 0.022);
    n.gap = 0;
  }
}

/**
 * ORDER-PRESERVING strip treemap.
 *
 * Fills horizontal strips left to right, top to bottom, closing a strip when
 * adding the next item would worsen its mean aspect ratio. Reading order is
 * exactly array order, which after rollUp() is chronological. Aspect ratios are
 * a little worse than squarify's, which matters little now that cards flow text
 * into multiple columns: a wide strip is a fine card shape.
 */
function stripLayout(nodes, rect, gap) {
  let total = 0;
  for (const n of nodes) total += lw(n);
  if (total <= 0) total = 1;

  const scale = (rect.w * rect.h) / total;
  const width = rect.w;
  if (width <= 0) return;

  // 1. Greedy strips, in order.
  const strips = [];
  let i = 0;
  while (i < nodes.length) {
    let count = 1;
    let sum = lw(nodes[i]) * scale;
    let best = stripAspect(nodes, i, count, sum, width, scale);

    while (i + count < nodes.length) {
      const nextSum = sum + lw(nodes[i + count]) * scale;
      const cand = stripAspect(nodes, i, count + 1, nextSum, width, scale);
      if (cand > best) break;
      count++;
      sum = nextSum;
      best = cand;
    }
    strips.push({ from: i, count, sum });
    i += count;
  }

  // 2. The final strip gets whatever is left over, stretched to the full
  //    width -- often one or two items as a thin, very wide sliver. Text in a
  //    box like that has to shrink until it is unreadable (measured: 0.3% font
  //    scale, readable only at 217x zoom). Fold it into the strip above while
  //    that improves the worst box shape. Order is untouched: it only moves a
  //    strip boundary.
  while (strips.length >= 2) {
    const last = strips[strips.length - 1];
    const prev = strips[strips.length - 2];
    const apart = Math.max(
      stripWorst(nodes, last.from, last.count, last.sum, width, scale),
      stripWorst(nodes, prev.from, prev.count, prev.sum, width, scale)
    );
    const merged = stripWorst(nodes, prev.from, prev.count + last.count, prev.sum + last.sum, width, scale);
    if (merged >= apart) break;
    prev.count += last.count;
    prev.sum += last.sum;
    strips.pop();
  }

  // 3. Place.
  const half = gap / 2;
  let y = rect.y;
  for (const st of strips) {
    const h = st.sum / width;
    let x = rect.x;
    for (let k = 0; k < st.count; k++) {
      const n = nodes[st.from + k];
      const w = (lw(n) * scale / st.sum) * width;
      n.x = x + half;
      n.y = y + half;
      n.w = Math.max(0.5, w - gap);
      n.h = Math.max(0.5, h - gap);
      x += w;
    }
    y += h;
  }
}

/** Worst (largest) aspect ratio of `count` items starting at `from` in one strip. */
function stripWorst(nodes, from, count, sum, width, scale) {
  if (sum <= 0 || width <= 0) return Infinity;
  const h = sum / width;
  let worst = 0;
  for (let k = 0; k < count; k++) {
    const w = (lw(nodes[from + k]) * scale / sum) * width;
    const r = w > h ? w / h : h / w;
    if (r > worst) worst = r;
  }
  return worst;
}

/**
 * Aspect criterion for growing a strip: the WORST box in it, not the mean.
 * With the mean, a strip happily absorbs one tiny item as a 1-unit-wide sliver
 * whenever the average still improves -- measured: hour boxes 1 x 2,787 world
 * units, their text wrapped at one character per line. Squarified treemaps use
 * the worst box for exactly this reason.
 */
function stripAspect(nodes, from, count, sum, width, scale) {
  return stripWorst(nodes, from, count, sum, width, scale);
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
  buildTree, layoutAuto, stripLayout, clipWeight,
  DEPTH, CARD_FONT_PX, CARD_LINE_H, CARD_CHAR_W, COL_GAP,
  BASE_AREA, MIN_FACTOR, MAX_FACTOR, FONT_SCALE_FLOOR, READABLE_PX,
  MONTH_SHORT, MONTH_LONG, WEEKDAY_SHORT,
  toDate, clockLabel, hourLabel, dayLabel, hourKey,
};
