// ─── src/main/hotkey.js ──────────────────────────────────────────────────────
// The global shortcut that opens ClipCanvas: the defaults, which shortcuts may
// be chosen instead, which one to use when some are taken, and how they are
// written.
//
// WHY WIN+ALT+V
// A global shortcut is taken from EVERY app while ClipCanvas runs. The obvious
// choice, Ctrl+Shift+V, is "paste as plain text" in Chrome, Edge and Word,
// "paste" in Windows Terminal and "Markdown preview" in VS Code, and would
// stop working in all of them. Win+Alt+V sits beside Windows' own clipboard
// history (Win+V), and apps almost never use Win shortcuts. Any shortcut may
// already be held by another program, which is why there is a list of
// fallbacks, not one default.
//
// Accelerators are kept in one canonical form -- modifiers in the order Super
// (Win), Ctrl, Alt, Shift, as Windows writes them, then one key in Electron's
// spelling -- so a saved shortcut compares equal however it was typed.
//
// Pure: main.js registers; test/verify-hotkey.js checks this file.
// ─────────────────────────────────────────────────────────────────────────────

// Tried in order until one can be registered.
const DEFAULT_HOTKEYS = ["Super+Alt+V", "Ctrl+Alt+V", "Ctrl+Alt+Shift+V"];
const DEFAULT_HOTKEY = DEFAULT_HOTKEYS[0];

const MODIFIER_ORDER = ["Super", "Ctrl", "Alt", "Shift"];
const MODIFIERS = {
  ctrl: "Ctrl", control: "Ctrl", commandorcontrol: "Ctrl", cmdorctrl: "Ctrl",
  alt: "Alt", option: "Alt", altgr: "Alt",
  shift: "Shift",
  super: "Super", meta: "Super", win: "Super", windows: "Super", cmd: "Super", command: "Super",
};

// Named keys, by lower-case alias, in Electron's spelling.
const NAMED = {
  space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete",
  insert: "Insert", ins: "Insert", return: "Enter", enter: "Enter",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  esc: "Esc", escape: "Esc", plus: "Plus",
};
const PUNCTUATION = "-=[];',./`\\";

// Taking these from every app would break the basics of using Windows.
const RESERVED = new Set([
  "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Y", "Ctrl+Z",
  "Ctrl+F", "Ctrl+N", "Ctrl+O", "Ctrl+P", "Ctrl+S", "Ctrl+T", "Ctrl+W",
  "Ctrl+Esc", "Ctrl+Alt+Delete", "Ctrl+Shift+Esc",
  "Alt+Tab", "Alt+F4", "Alt+Space", "Alt+Esc",
  "Super+D", "Super+E", "Super+L", "Super+R", "Super+V", "Super+Tab", "Super+Shift+S",
]);

/** Canonical accelerator, or null if `acc` is not one modifier-set plus one key. */
function normalize(acc) {
  const text = String(acc || "").trim();
  if (!text) return null;
  // "Ctrl++" means Ctrl and the plus key.
  const parts = text.replace(/\+\+$/, "+Plus").split("+").map((s) => s.trim());
  if (parts.some((p) => !p)) return null;

  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const mod = MODIFIERS[p.toLowerCase()];
    if (mod) { mods.add(mod); continue; }
    if (key) return null; // two keys
    key = keyName(p);
    if (!key) return null;
  }
  if (!key) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

function keyName(p) {
  if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) return p.toUpperCase();
  if (p.length === 1 && PUNCTUATION.includes(p)) return p;
  return NAMED[p.toLowerCase()] || null;
}

/**
 * May `acc` be the shortcut? `warning` is set for shortcuts that are allowed
 * but that other apps commonly use.
 * @returns {{ok: boolean, hotkey?: string, error?: string, warning?: string}}
 */
function check(acc) {
  const hotkey = normalize(acc);
  if (!hotkey) return { ok: false, error: "That is not a shortcut Windows can use." };
  const parts = hotkey.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);

  if (!mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Super")) {
    return { ok: false, error: "Include Ctrl, Alt or the Windows key — otherwise the shortcut would fire while you type." };
  }
  if (RESERVED.has(hotkey)) {
    return { ok: false, error: `${display(hotkey)} is one of Windows' basic shortcuts. Taking it would break it in every app.` };
  }

  let warning;
  const combo = mods.join("+");
  if ((combo === "Ctrl" || combo === "Ctrl+Shift") && /^[A-Z0-9]$/.test(key)) {
    warning = `Many apps use ${display(hotkey)}. While ClipCanvas runs, they won't receive it.`;
  } else if (combo === "Alt" && /^[A-Z]$/.test(key)) {
    warning = `Alt + a letter opens menus in many apps. While ClipCanvas runs, ${display(hotkey)} won't.`;
  }
  return warning ? { ok: true, hotkey, warning } : { ok: true, hotkey };
}

/**
 * Which shortcut to use: the saved one if it can be registered, otherwise the
 * first default that can. `register(accelerator)` tries one and returns
 * whether it worked. `note` explains, in the Settings window's words, any
 * shortcut other than the one the user would expect -- or that none worked.
 * @returns {{hotkey: string|null, note: string|null}}
 */
function choose(saved, register) {
  const tried = [];
  if (saved) {
    if (register(saved)) return { hotkey: saved, note: null };
    tried.push(saved);
  }
  for (const d of DEFAULT_HOTKEYS) {
    if (d === saved) continue;
    if (register(d)) {
      if (!tried.length) return { hotkey: d, note: null };
      // Name what the user expected -- their own, or the first default -- not
      // every fallback that happened to be taken on the way.
      const expected = saved ? [saved] : [DEFAULT_HOTKEY];
      return { hotkey: d, note: `${list(expected)} is used by another app, so ClipCanvas is using ${display(d)}.` };
    }
    tried.push(d);
  }
  return { hotkey: null, note: `${list(tried)} are all taken by other apps. Click the box and pick a shortcut.` };
}

function list(accs) {
  const names = accs.map(display);
  return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/** "Super+Alt+V" -> "Win + Alt + V". */
function display(hotkey) {
  return String(hotkey).split("+").map((p) => (p === "Super" ? "Win" : p)).join(" + ");
}

module.exports = { DEFAULT_HOTKEY, DEFAULT_HOTKEYS, normalize, check, choose, display, RESERVED };
