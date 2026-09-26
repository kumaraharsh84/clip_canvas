// ─── src/main/classifyText.js ────────────────────────────────────────────────
// The type a captured text clip is STORED as: "url", "code" or "text".
//
// This used to be a handful of loose regexes in main.js, and it is where the
// prose-shown-as-"Other code" problem started: one code-ish signal plus two
// indented lines made anything "code", and a case-insensitive
// SELECT|UPDATE|CREATE test matched ordinary sentences such as "Create a folder
// named ...". Measured on real history, 81 of the 245 clips stored as code were
// chats, prompts, plans and reports.
//
// It now defers to the detectors the canvas uses to DISPLAY a clip
// (src/renderer/canvas/classify.js), so what is stored and what is shown cannot
// disagree. That module is plain CommonJS with no DOM access, so the main
// process can load it directly.
// ─────────────────────────────────────────────────────────────────────────────

const {
  looksLikeTerminal, looksLikeProse, startsLikeSource, looksLikeSql, scoreLanguage,
  detect, CLASSIFIER_VERSION,
} = require("../renderer/canvas/classify");

function classify(text) {
  const t = String(text || "").trim();
  if (/^https?:\/\/\S+$/i.test(t)) return "url";
  const head = t.length > 4000 ? t.slice(0, 4000) : t;

  // Same order as the display side (classify.js detect()).
  if (looksLikeTerminal(head)) return "code";                 // shown as Shell
  const lang = scoreLanguage(head);
  if (lang.score === Infinity) return "code";                // JSON / key-value config
  if (startsLikeSource(head) || looksLikeSql(head, lang)) return "code";
  if (looksLikeProse(head)) return "text";
  if (lang.lang !== "code") return "code";                    // a language was detected

  // Neither prose nor a recognised language: code only on positive evidence.
  return looksLikeCodeFragment(t) ? "code" : "text";
}

/**
 * The old capture heuristic, kept as the last resort for fragments no detector
 * recognises (an object literal, a stray block). Two fixes from the original:
 * SQL keywords are no longer matched case-insensitively -- that is what made
 * "Create a folder..." look like SQL -- and the indentation test is
 * /^(?: {2,}|\t)/, not /^\s{2,}|\t/, which by precedence meant "starts with two
 * spaces OR contains a tab anywhere".
 */
function looksLikeCodeFragment(t) {
  const signals = [
    /[{};]\s*$/m,
    /^\s*(?:function|class|const|let|var|import|export|def|public|private)\b/m,
    /^\s*(?:if|for|while|switch|return)\s*\(/m,
    /=>/,
    /^\s*<\/?[a-z][\w-]*[\s>]/im,
  ].reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  const indented = t.split("\n").filter((l) => /^(?: {2,}|\t)/.test(l)).length;
  return signals >= 2 || (signals >= 1 && indented >= 2);
}

/**
 * The finer category the canvas colours a clip by ("js", "sql", "prose",
 * "image", ...), stored in clips.category. Runs the canvas's own detector on
 * the stored row, never a copy of it.
 */
function categorize(clip) {
  return detect({ type: clip.type, content: clip.content }).id;
}

module.exports = { classify, categorize, CLASSIFIER_VERSION };
