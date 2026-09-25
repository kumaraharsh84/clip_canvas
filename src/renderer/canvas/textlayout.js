// ─── src/renderer/canvas/textlayout.js ───────────────────────────────────────
// Full-text wrapping for clip cards. NOTHING here truncates.
//
// WHY MONOSPACE
// The requirement is that a card shows the entire copied text, not a 2-3 line
// preview. That means the treemap needs each clip's exact text area BEFORE
// drawing, for possibly thousands of clips. Doing that with ctx.measureText()
// per word is far too slow, and estimating it means the real wrap disagrees
// with the reserved box and the text overflows -- truncation by another name.
//
// A monospace body font removes the problem outright: every glyph has the same
// advance, so
//       charsPerLine = floor(innerWidth / charWidth)
// and wrapping becomes integer arithmetic -- exact, measurement-free, stable.
// It is also the right typography for copied text and code. Proportional fonts
// are still used for chrome (labels, meta), which is short and drawn once.
//
// ONE ALGORITHM, TWO MODES
// countLines() and wrapLines() MUST agree exactly or the layout reserves the
// wrong area. An earlier version kept two hand-written implementations in sync
// and a fuzz test found them disagreeing on 12% of random inputs. So there is
// now exactly one scanner, walkText(), and counting is just "run it without
// collecting". Agreement is structural, not a thing to re-verify.
//
// WHITESPACE IS PRESERVED
// Runs of spaces are NOT collapsed. This is a clipboard manager: clips are code
// and indentation carries meaning. Only the single space a line is broken ON is
// consumed, exactly as a terminal soft-wrap behaves.
// ─────────────────────────────────────────────────────────────────────────────

const { LRU } = require("./lru");

// Cache of char advance width per font string. One measureText per font, ever.
const charWidthCache = new Map();

function charWidth(ctx, font) {
  let w = charWidthCache.get(font);
  if (w === undefined) {
    const prev = ctx.font;
    ctx.font = font;
    // "0" is a reliable advance sample; in a true monospace every glyph matches.
    w = ctx.measureText("0").width;
    ctx.font = prev;
    charWidthCache.set(font, w);
  }
  return w;
}

function charsPerLine(ctx, font, innerWidth) {
  return Math.max(1, Math.floor(innerWidth / charWidth(ctx, font)));
}

const isSpace = (code) => code === 32 || code === 9;

// ── The one scanner ──────────────────────────────────────────────────────────
/**
 * Greedy soft-wrap of text[start,end) at `cols` columns.
 * Pushes line strings into `out` when `out` is an array; pass null to count
 * only, which allocates nothing.
 * @returns {number} number of visual lines produced
 */
function walkSegment(text, start, end, cols, out) {
  let lines = 0;
  let p = start;

  if (end <= start) {
    if (out) out.push("");
    return 1;
  }

  while (p < end) {
    // Remainder fits on one line.
    if (end - p <= cols) {
      if (out) out.push(text.slice(p, end));
      return lines + 1;
    }

    // The line can hold text[p .. p+cols). A break AT p+cols is also legal:
    // it yields a full line of exactly `cols` chars and consumes the space.
    const limit = p + cols;
    let brk = -1;
    for (let q = limit; q > p; q--) {
      if (isSpace(text.charCodeAt(q))) { brk = q; break; }
    }

    if (brk > p) {
      if (out) out.push(text.slice(p, brk));
      p = brk + 1;            // consume exactly the one space broken on
    } else {
      // No break opportunity (a single over-long token, or leading indent):
      // hard-break mid-token rather than eating the indentation.
      if (out) out.push(text.slice(p, limit));
      p = limit;
    }
    lines++;
  }

  // Ended exactly on a consumed break -> there is a final empty line.
  if (p === end) {
    if (out) out.push("");
    lines++;
  }
  return lines;
}

/** Run the scanner across every hard line of `text`. */
function walkText(text, cols, out) {
  const src = text || "";
  if (src.length === 0) {
    if (out) out.push("");
    return 1;
  }

  let lines = 0;
  let i = 0;
  const n = src.length;

  for (;;) {
    let nl = src.indexOf("\n", i);
    const isLast = nl === -1;
    if (isLast) nl = n;

    lines += walkSegment(src, i, nl, cols, out);

    if (isLast) break;
    i = nl + 1;
    if (i === n) {            // trailing newline -> one final empty line
      if (out) out.push("");
      lines++;
      break;
    }
  }
  return lines;
}

// ── Public API ───────────────────────────────────────────────────────────────
/** Exact visual line count. Allocates nothing -- safe to call per clip. */
function countLines(text, cols) {
  return walkText(text, cols, null);
}

// Budgeted by characters held, not entry count: one 2 MB clip must not evict a
// thousand small ones, and a thousand small ones must not quietly add up.
const wrapCache = new LRU({ maxCost: 4000000 });

/** The wrapped lines of `text` at `cols`, LRU-cached on (clipId, cols). */
function wrapLines(clipId, text, cols) {
  const key = clipId + ":" + cols;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const out = [];
  walkText(text, cols, out);
  wrapCache.set(key, out, (text || "").length + 64);
  return out;
}

// ── Multi-column card flow ───────────────────────────────────────────────────
// A squarified treemap decides each card's SHAPE; it only honours its AREA.
// Text, though, has a strongly preferred shape, so a single-column card can be
// handed a box with ample area but the wrong proportions and still not fit --
// most visibly for pre-formatted clips (code, logs) whose line count is pinned
// by their own newlines and does not fall as the box gets wider. Measured with
// single-column flow, a rotating ~0.2% of clips never settled, plateauing about
// 1.23x too short no matter how many fixpoint passes ran.
//
// Flowing the text into multiple columns when the card is wider than one column
// needs removes the shape dependence: a wide card uses its width for more
// columns instead of longer lines, so AREA becomes the binding constraint --
// and area is exactly what the treemap already guarantees, because a clip's
// weight IS its rendered text area. It is also how you would set this text on
// paper, and it matches the dense packing of the reference visualiser.
//
// layout.js and renderer2d.js MUST agree on this geometry or cards clip their
// own text, so both call this one function rather than each deriving it.

const TARGET_COL_CHARS = 72; // comfortable measure for a single column
const MIN_COL_CHARS = 20;    // below this, prefer fewer columns

/**
 * @returns {{columns, colChars, totalLines, linesPerColumn, neededHeight}}
 */
// Column shape limits. Without them, a card the strip layout made very wide
// and very short -- the last strip of a container often is -- pours its text
// into hundreds of one-line columns: complete, and unreadable. Measured on 20k
// clips, one card flowed into 1,929 columns. Columns are kept at least
// MIN_LINES_PER_COL lines tall and at most MAX_COL_CHARS wide, and the font
// shrinks instead (fitCard) when that is what it takes to fit.
const MIN_LINES_PER_COL = 12;
const MAX_COL_CHARS = 120;

function cardFlow(text, innerWidth, charW, lineH, colGap) {
  const shape = (wanted) => {
    let k = Math.max(1, wanted);
    let cc;
    // Keep columns readable: fewer, wider columns rather than slivers.
    for (;;) {
      const usable = innerWidth - (k - 1) * colGap;
      cc = Math.floor(usable / k / charW);
      if (cc >= MIN_COL_CHARS || k === 1) break;
      k--;
    }
    cc = Math.max(1, Math.min(MAX_COL_CHARS, cc));
    return { columns: k, colChars: cc, totalLines: countLines(text, cc) };
  };

  const byWidth = Math.floor((innerWidth + colGap) / (TARGET_COL_CHARS * charW + colGap));
  let f = shape(byWidth);

  // Too few lines to fill that many columns: use fewer, taller ones. Widening
  // columns shortens the text, which can leave it short again, so repeat until
  // it settles -- the column count strictly falls, so this terminates.
  while (f.columns > 1 && f.totalLines < f.columns * MIN_LINES_PER_COL) {
    const next = Math.max(1, Math.min(f.columns - 1, Math.floor(f.totalLines / MIN_LINES_PER_COL)));
    f = shape(next);
  }

  const linesPerColumn = Math.ceil(f.totalLines / f.columns);
  return {
    columns: f.columns,
    colChars: f.colChars,
    totalLines: f.totalLines,
    linesPerColumn,
    neededHeight: linesPerColumn * lineH,
  };
}

function clearCaches() { wrapCache.clear(); charWidthCache.clear(); }
function cacheStats() { return { wrap: wrapCache.stats(), fonts: charWidthCache.size }; }

module.exports = {
  charWidth, charsPerLine,
  countLines, wrapLines, cardFlow,
  TARGET_COL_CHARS, MIN_COL_CHARS, MIN_LINES_PER_COL, MAX_COL_CHARS,
  clearCaches, cacheStats,
};
