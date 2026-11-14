// ─── src/renderer/canvas/tokens.js ───────────────────────────────────────────
// Split a wrapped line into coloured runs.
//
// This is where the reference's texture comes from. Zoomed out, each of its
// file boxes is a field of short coloured dashes -- keywords one colour,
// strings another -- and that pattern is what makes the mosaic read as TEXT
// rather than as flat tiles. Every clip card gets the same treatment: prose is
// word-dashes in the category hue, code is syntax-coloured runs.
//
// It is a scanner, not a parser. It runs per visible line, so it has to be
// cheap, and the look depends on colour variation, not on correct grammar. A
// string that wraps across two lines is simply coloured as two lines.
//
// A run is three numbers [start, end, tokenClass]; a line's runs are one flat
// array. Whitespace produces no run -- the gaps between words are the texture.
// ─────────────────────────────────────────────────────────────────────────────

const { TOKEN } = require("./classify");
const { LRU } = require("./lru");

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = "break case catch class const continue debugger default delete do else export " +
  "extends false finally for from function if import in instanceof let new null of return " +
  "static super switch this throw true try typeof undefined var void while with yield async " +
  "await interface type enum implements private public protected readonly";
const PY_KW = "and as assert async await break class continue def del elif else except False " +
  "finally for from global if import in is lambda None nonlocal not or pass raise return " +
  "self True try while with yield print";
const C_KW = "int float double char void bool struct enum union public private protected static " +
  "final interface return if else for while switch case break continue new delete namespace " +
  "using include define template typename auto const unsigned signed long short package func " +
  "fn let mut impl trait pub use mod match go defer chan";

const KEYWORDS = {
  js: words(JS_KW),
  py: words(PY_KW),
  sql: words(
    "select from where insert into values update set delete create table index view trigger " +
    "drop alter add column join left right inner outer full cross on as and or not null is in " +
    "like between exists distinct group by order having limit offset union all case when then " +
    "else end primary key foreign references default integer int text real varchar char boolean " +
    "date timestamp count sum avg min max asc desc if begin commit rollback virtual using"
  ),
  shell: words(
    "cd ls dir echo export set unset sudo apt apt-get brew pip pip3 python python3 node npm npx " +
    "yarn pnpm git docker kubectl curl wget mkdir rm cp mv cat chmod chown grep sed awk find if " +
    "then else fi for do done while case esac function return in winget choco ssh scp"
  ),
  css: words("important media import keyframes font-face from to hover focus active before after root not"),
  json: words("true false null"),
  html: new Set(),
  code: words(JS_KW + " " + PY_KW + " " + C_KW),
};

// Languages whose SQL-style keywords are case-insensitive.
const CASE_INSENSITIVE = new Set(["sql"]);

const isWord = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
  c === 95 || c === 36 || c >= 128;
const isDigit = (c) => c >= 48 && c <= 57;
const isNumPart = (c) => isWord(c) || c === 46;
const isQuote = (c) => c === 34 || c === 39 || c === 96;

function commentAt(line, i, lang) {
  const c = line.charCodeAt(i);
  switch (lang) {
    case "py":
    case "shell":
      return c === 35; // #
    case "sql":
      return c === 45 && line.charCodeAt(i + 1) === 45; // --
    case "html":
      return line.startsWith("<!--", i);
    default:
      // js, css, json, code: // and /*
      return c === 47 && (line.charCodeAt(i + 1) === 47 || line.charCodeAt(i + 1) === 42);
  }
}

/**
 * Runs for one wrapped line.
 * @param {string} line
 * @param {string} lang  a category's tokenizer name (prose, url, js, py, ...)
 * @returns {number[]}   flat [start, end, class, start, end, class, ...]
 */
function tokenizeLine(line, lang) {
  const out = [];
  const n = line.length;
  if (!n) return out;

  if (lang === "url") {
    let a = 0;
    let b = n;
    while (a < b && line.charCodeAt(a) <= 32) a++;
    while (b > a && line.charCodeAt(b - 1) <= 32) b--;
    if (b > a) out.push(a, b, TOKEN.LINK);
    return out;
  }

  const prose = lang === "prose" || lang === "none";
  const kw = KEYWORDS[lang];
  const lower = CASE_INSENSITIVE.has(lang);
  let i = 0;

  while (i < n) {
    const c = line.charCodeAt(i);

    if (c === 32 || c === 9) { i++; continue; }

    if (!prose) {
      if (commentAt(line, i, lang)) { out.push(i, n, TOKEN.COMMENT); break; }

      if (isQuote(c) && !(c === 96 && lang === "sql")) {
        let j = i + 1;
        while (j < n) {
          const d = line.charCodeAt(j);
          if (d === 92) { j += 2; continue; } // backslash escape
          j++;
          if (d === c) break;
        }
        if (j > n) j = n;
        out.push(i, j, TOKEN.STRING);
        i = j;
        continue;
      }

      if (lang === "html" && c === 60) { // <tag ...>
        let j = i + 1;
        while (j < n && line.charCodeAt(j) !== 62) j++;
        if (j < n) j++;
        out.push(i, j, TOKEN.TAG);
        i = j;
        continue;
      }

      if (isDigit(c)) {
        let j = i + 1;
        while (j < n && isNumPart(line.charCodeAt(j))) j++;
        out.push(i, j, TOKEN.NUMBER);
        i = j;
        continue;
      }
    }

    if (isWord(c)) {
      let j = i + 1;
      while (j < n && isWord(line.charCodeAt(j))) j++;
      let cls = TOKEN.WORD;
      if (!prose) {
        const w = line.slice(i, j);
        cls = kw && kw.has(lower ? w.toLowerCase() : w) ? TOKEN.KEYWORD : TOKEN.IDENT;
      }
      out.push(i, j, cls);
      i = j;
      continue;
    }

    // Punctuation run. Stops at anything that starts a different token so a
    // `;//` does not swallow the comment after it.
    let j = i + 1;
    while (j < n) {
      const d = line.charCodeAt(j);
      if (d === 32 || d === 9 || isWord(d)) break;
      if (!prose && (isQuote(d) || commentAt(line, j, lang))) break;
      j++;
    }
    out.push(i, j, TOKEN.PUNCT);
    i = j;
  }

  return out;
}

// ── Cache ────────────────────────────────────────────────────────────────────
// One record per (clip, column width). Lines are tokenized lazily, on first
// paint: a 14,000-line paste whose card only ever shows 40 lines at a time
// should not pay to tokenize the other 13,960.
const recCache = new LRU({ maxCost: 2000000 });

/** The token record for a clip's wrapped lines. */
function tokenRecord(key, lang, lines) {
  let rec = recCache.get(key);
  if (!rec || rec.lines !== lines) {
    rec = { lang, lines, runs: new Array(lines.length) };
    recCache.set(key, rec, lines.length * 6 + 32);
  }
  return rec;
}

/** Runs for line i of a record, tokenizing it on first use. */
function runsAt(rec, i) {
  let r = rec.runs[i];
  if (r === undefined) {
    r = tokenizeLine(rec.lines[i], rec.lang);
    rec.runs[i] = r;
  }
  return r;
}

module.exports = { tokenizeLine, tokenRecord, runsAt, KEYWORDS };
