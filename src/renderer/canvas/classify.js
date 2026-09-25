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
  if (clip.type === "code") {
    // A copy out of a terminal is Shell. Left to the language vote, its
    // command output made it Other code, JSON or SQL.
    if (looksLikeTerminal(head)) return CATEGORIES.shell;
    return CATEGORIES[detectLanguage(head)] || CATEGORIES.code;
  }

  if (trimmed.length <= 80 && trimmed.indexOf("\n") === -1) return CATEGORIES.snippet;
  return CATEGORIES.prose;
}

// Weighted signals per language. A language needs a score of at least 2 to be
// claimed; below that the clip is plain "Other code".
const SIGNALS = {
  sql: [
    [3, /\bselect\b[\s\S]{0,600}?\bfrom\b/i],
    [3, /\binsert\s+into\b/i],
    [3, /\bupdate\s+[\w."`[\]]+\s+set\b/i],
    [3, /\bdelete\s+from\b/i],
    [3, /\bcreate\s+(?:virtual\s+)?(?:table|index|view|trigger)\b/i],
    [1, /\b(?:where|inner\s+join|left\s+join|group\s+by|order\s+by)\b/i],
  ],
  py: [
    [3, /^[ \t]*def\s+\w+\s*\(.*\)\s*(?:->\s*[^:\n]+)?:\s*$/m],
    [3, /^[ \t]*class\s+\w+\s*(?:\([^)\n]*\))?\s*:\s*$/m],
    [2, /^[ \t]*(?:from\s+[\w.]+\s+)?import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+)*\s*$/m],
    [2, /\bself\.\w+/],
    [2, /^[ \t]*elif\b/m],
    [1, /\b(?:None|True|False)\b/],
    [1, /^[ \t]*(?:if|for|while|with|try|except|else|finally)\b[^\n{;]*:\s*$/m],
    [1, /__\w+__/],
  ],
  js: [
    [2, /\b(?:const|let|var)\s+[\w${[]/],
    [1, /=>/],
    [1, /\bfunction\b/],
    [2, /\brequire\s*\(|^[ \t]*import\s[^\n]*\sfrom\s+['"]|^[ \t]*import\s+['"]/m],
    [2, /^[ \t]*export\s/m],
    [2, /\b(?:console|document|window|module|process)\.\w/],
    [2, /===|!==/],
    [1, /;\s*$/m],
    [1, /\b(?:async|await)\b/],
    [1, /\b(?:interface|type)\s+\w+\s*(?:=|\{|<)/],
  ],
  css: [
    // A rule block with a declaration in it. Written as a function rather than
    // one regex: the obvious single regex backtracks quadratically on long
    // brace-free input, and this runs on every code clip.
    [3, (s) => {
      if (/\b(?:function|return|const|let|var)\b/.test(s)) return false;
      const m = s.match(/\{([^{}]{1,2000})\}/);
      return !!m && /(?:^|[;\s])[\w-]+\s*:\s*[^;:{}]+;/.test(m[1]);
    }],
    [2, /@(?:media|import|keyframes|font-face|supports)\b/],
    [1, /^[ \t]*[\w-]+\s*:\s*[^;{}\n]+;\s*$/m],
    [1, /#[0-9a-fA-F]{3,8}\b/],
  ],
  shell: [
    [2, /^[ \t]*(?:\$|>|PS\s+[A-Z]:\\[^>\n]*>)\s*\S/m],
    [2, /^[ \t]*(?:sudo\s+)?(?:npm|npx|yarn|pnpm|git|cd|ls|dir|echo|apt(?:-get)?|brew|pip3?|python3?|node|docker|kubectl|curl|wget|mkdir|rm|cp|mv|cat|chmod|export|winget|choco|ssh|scp)\b/m],
    [3, /\b(?:Get|Set|New|Remove|Start|Stop|Invoke)-[A-Z]\w+|\$env:\w+/],
    [1, /\s--?[a-zA-Z][\w-]*/],
    [1, /\|\s*\w|&&/],
  ],
  html: [
    [3, /<!DOCTYPE|<\?xml/i],
    [3, /<\/?(?:html|head|body|div|span|p|a|ul|ol|li|table|tr|td|th|script|style|section|header|footer|nav|main|button|input|form|img|svg|template|label|select|option)\b[^>]*>/i],
    [1, /<\/[a-zA-Z][\w:-]*>/],
  ],
};
const ORDER = ["sql", "py", "js", "css", "shell", "html"];

function detectLanguage(src) {
  return scoreLanguage(src).lang;
}

/**
 * The best-scoring language and how strongly it scored. JSON and key/value
 * config are structural checks and count as certain (score Infinity).
 */
function scoreLanguage(src) {
  const s = src.length > 4000 ? src.slice(0, 4000) : src;
  const t = s.trim();
  if (!t) return { lang: "code", score: 0 };

  // JSON, and key/value config (YAML, .env, ini) that reads like it.
  if (/^[[{]/.test(t) && /"[^"\n]{1,120}"\s*:/.test(t)) return { lang: "json", score: Infinity };
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length >= 2) {
    const kv = lines.filter((l) => /^\s*[\w.-]+\s*[:=]\s*\S/.test(l) && !/[;{}()]/.test(l)).length;
    if (kv / lines.length >= 0.75) return { lang: "json", score: Infinity };
  }

  let best = "code";
  let bestScore = 1;
  for (const lang of ORDER) {
    let score = 0;
    for (const [weight, test] of SIGNALS[lang]) {
      if (typeof test === "function" ? test(s) : test.test(s)) score += weight;
    }
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return { lang: best, score: best === "code" ? 0 : bestScore };
}

// ── Terminal sessions ────────────────────────────────────────────────────────
// A line that is a prompt, a command typed at one, or characteristic command
// output. Judged per LINE, never "anywhere in the clip": a chat message that
// quotes one command is still a chat -- matching anywhere is exactly how
// Hinglish replies like "ye rahe commands, ek-ek karke run karo" were being
// filed as Shell.
const TERMINAL_LINE = [
  /^\s*(?:\([\w.-]+\)\s+)?[A-Za-z]?:\\[^>\n]*>/,            // C:\Users\demo>ping   (cmd; drive letter may be cut)
  /^.{0,24}?\bPS\s+[A-Za-z]:\\[^>\n]*>/,                    // (.venv) PS D:\proj>  (PowerShell)
  /^.{0,40}?\b[\w.-]+@[\w.-]+:[~/][^\n]*?[$#](?:\s|$)/,     // user@host:~/dir$     (bash)
  /^Microsoft Windows \[Version \d/,                         // cmd banner
  /^\s*Directory of [A-Za-z]:\\/,                            // dir output
  /^(?:::|REM)\s/,                                            // batch-file comments
  /^\s*(?:sudo\s+)?(?:ipconfig|netsh|tracert|nslookup|robocopy|xcopy|systemctl|journalctl|Test-NetConnection|(?:Get|Set|New|Remove|Start|Stop|Invoke)-[A-Z]\w+)\b/,
  /^\s*(?:ping|tree)\s+\S/,                                  // ping host, tree /A
  /^\s*(?:Loaded|Active|Main PID|CGroup):\s/,                 // systemctl status
  /^\s*[●•*]?\s*[\w@.-]+\.service\s+-\s/,                     // systemctl status header
  /^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} [\w.-]+ [\w.@-]+(?:\[\d+\])?:/, // journal lines
  /^At (?:line:\d+|[A-Za-z]:\\[^\n]*:\d+) char:\d+/,           // PowerShell error position
  /^\s*\+\s+(?:~+|CategoryInfo\s*:|FullyQualifiedErrorId\s*:)/, // PowerShell error detail
];

// A clip that begins with a bare command is a command list or session, even
// without a prompt: "cd ~/proj", "git status", "npm install".
const BARE_COMMAND = /^\s*(?:sudo\s+)?(?:cd|ls|npm|npx|yarn|pnpm|git|pip3?|python3?|node|docker|kubectl|curl|wget|mkdir|rm|cp|mv|cat|chmod|export|source|conda|winget|choco|ssh|scp|tar|unzip|apt(?:-get)?|brew)\s+\S/;
// PowerShell / CLI table output: a header line, then dashes under each column.
const TABLE_UNDERLINE = /^\s*-{2,}(?:\s+-{2,})+\s*$/;

const isTerminalLine = (line) => TERMINAL_LINE.some((re) => re.test(line));

/**
 * A copy out of a terminal: it starts at a prompt or command -- which is where
 * you start selecting in a terminal -- or it is command output shaped like a
 * table, or at least 30% of its lines are prompts, commands or command output.
 */
function looksLikeTerminal(src) {
  const lines = src.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  if (isTerminalLine(lines[0]) || BARE_COMMAND.test(lines[0])) return true;
  if (lines.length > 1 && TABLE_UNDERLINE.test(lines[1])) return true;
  let n = 0;
  for (const l of lines) if (isTerminalLine(l)) n++;
  return n / lines.length >= 0.3;
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
  categoryOf, blockOf, detectLanguage, scoreLanguage,
  looksLikeTerminal,
  mix, rgbCss, hexToRgb,
};
