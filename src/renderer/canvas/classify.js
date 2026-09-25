// ─── src/renderer/canvas/classify.js ─────────────────────────────────────────
// What colour a clip is.
//
// The reference visualiser's mosaic is rich because every box is coloured by
// what KIND of file it is -- one hue per language -- so the zoomed-out view
// reads as regions of C++, of tests, of build files. Colouring clips by their
// four storage types (text / code / url / image) gives only four hues, and all
// 649 real clips have source = 'clipboard', so there was no second dimension
// to colour by. That is most of why the archive view looked flat.
//
// Detecting the language of code clips, and splitting prose from one-line
// snippets, gives a dozen categories -- and they are categories you actually
// think in ("that SQL I copied on Tuesday").
//
// Detection is heuristic and deliberately cheap: it reads at most the first
// 4 KB of a clip, once, and the result is cached per clip object.
// ─────────────────────────────────────────────────────────────────────────────

const BG = [11, 15, 20];          // #0b0f14 -- must match renderer2d THEME.bg
const WHITE = [255, 255, 255];
const TEXT = [201, 214, 224];     // neutral identifier ink

// Token classes produced by tokens.js. Kept here so the palette and the
// tokenizer cannot drift apart.
const TOKEN = {
  IDENT: 0, KEYWORD: 1, STRING: 2, NUMBER: 3, COMMENT: 4,
  PUNCT: 5, TAG: 6, LINK: 7, WORD: 8,
};

// Syntax colours shared by every language, like any editor theme.
const UNIVERSAL = [
  [TOKEN.KEYWORD, "#c792ea"],
  [TOKEN.STRING, "#e6a86f"],
  [TOKEN.NUMBER, "#f2c86d"],
  [TOKEN.COMMENT, "#6f8f7c"],
  [TOKEN.PUNCT, "#7f93a8"],
  [TOKEN.TAG, "#f07fa8"],
  [TOKEN.LINK, "#4fd1c5"],
];

const DEFS = [
  // id        label            ink        tokenizer
  ["prose",   "Text",          "#5b9be0", "prose"],
  ["snippet", "Short text",    "#93a8bd", "prose"],
  ["url",     "Link",          "#3fc1ad", "url"],
  ["image",   "Image",         "#e0a458", "none"],
  ["js",      "JavaScript",    "#e3c567", "js"],
  ["py",      "Python",        "#4fb3c9", "py"],
  ["sql",     "SQL",           "#ec8a52", "sql"],
  ["html",    "HTML / XML",    "#e2699d", "html"],
  ["css",     "CSS",           "#a78bfa", "css"],
  ["json",    "JSON / config", "#aab94c", "json"],
  ["shell",   "Shell",         "#5ec46f", "shell"],
  ["code",    "Other code",    "#9d74e0", "code"],
  ["file",    "File",          "#8c9eb5", "none"],
];

const CATEGORIES = {};
const CATEGORY_LIST = [];

for (const [id, label, ink, lang] of DEFS) {
  const rgb = hexToRgb(ink);
  const blockRgb = mix(rgb, BG, 0.38);

  // A card is read at very different distances, so each category carries a
  // colour for each distance:
  //   block - solid fill when the card is a few pixels: the mosaic itself
  //   tint  - near-black background behind text, so the text carries
  //   faint - placeholder body while a card's texture is being painted
  //   head  - header band once the title is legible
  //   edge  - 1px outline, and the header strip when it is too small to read
  const cat = {
    id, label, ink, lang, rgb, blockRgb,
    block: rgbCss(blockRgb),
    tint: rgbCss(mix(rgb, BG, 0.88)),
    faint: rgbCss(mix(rgb, BG, 0.76)),
    head: rgbCss(mix(rgb, BG, 0.70)),
    edge: rgbCss(mix(rgb, BG, 0.28)),
    single: null,
    palette: [],
  };

  // Identifiers and prose words take a little of the category hue, so a card's
  // texture says what it is even when every line is only a coloured bar.
  cat.palette[TOKEN.IDENT] = rgbCss(mix(TEXT, rgb, 0.35));
  cat.palette[TOKEN.WORD] = rgbCss(mix(rgb, WHITE, 0.28));
  for (const [tok, css] of UNIVERSAL) cat.palette[tok] = css;

  // Prose and links are one colour per line, so real text can be drawn with a
  // single fillText per line instead of one per token.
  if (lang === "prose") cat.single = TOKEN.WORD;
  if (lang === "url") cat.single = TOKEN.LINK;

  CATEGORIES[id] = cat;
  CATEGORY_LIST.push(cat);
}

// ── Classification ───────────────────────────────────────────────────────────
const cache = new WeakMap();

/** The category a clip belongs to. Cached per clip object. */
function categoryOf(clip) {
  let cat = cache.get(clip);
  if (!cat) {
    cat = detect(clip);
    cache.set(clip, cat);
  }
  return cat;
}

function detect(clip) {
  if (clip.type === "image") return CATEGORIES.image;
  if (clip.type === "file") return CATEGORIES.file;

  const text = clip.content || "";
  const head = text.length > 4000 ? text.slice(0, 4000) : text;
  const trimmed = head.trim();

  if (clip.type === "url" || /^https?:\/\/\S+$/i.test(trimmed)) return CATEGORIES.url;
  if (clip.type === "code") return CATEGORIES.code;

  if (trimmed.length <= 80 && trimmed.indexOf("\n") === -1) return CATEGORIES.snippet;
  return CATEGORIES.prose;
}

/**
 * The clip's mosaic colour: its category block with a small, stable lightness
 * jitter. Neighbouring clips of the same kind would otherwise merge into one
 * flat slab; the jitter is what lets you count them from far away, the way the
 * reference's adjacent files stay distinct.
 */
function blockOf(clip, cat) {
  const c = cat || categoryOf(clip);
  const j = hash01(clip.id) * 2 - 1; // -1..1, stable per clip
  const rgb = j >= 0 ? mix(c.blockRgb, WHITE, j * 0.13) : mix(c.blockRgb, BG, -j * 0.22);
  return { rgb, css: rgbCss(rgb) };
}

// ── Colour helpers ───────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgbCss(c) {
  return "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")";
}

function hash01(v) {
  const s = String(v);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

module.exports = {
  CATEGORIES, CATEGORY_LIST, TOKEN, BG,
  categoryOf, blockOf,
  mix, rgbCss, hexToRgb,
};
