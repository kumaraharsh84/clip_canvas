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

const DEPTH = { YEAR: 0, MONTH: 1, DAY: 2, HOUR: 3, CLIP: 4 };

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July",
                    "August", "September", "October", "November", "December"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  DEPTH,
  MONTH_SHORT, MONTH_LONG, WEEKDAY_SHORT,
  toDate, clockLabel, hourLabel, dayLabel, hourKey,
};
