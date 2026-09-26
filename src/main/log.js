// ─── src/main/log.js ─────────────────────────────────────────────────────────
// Errors and notable events, written to a file you can open from the tray.
//
// ClipCanvas runs hidden in the tray all day, started by Windows with no
// console, so anything it prints goes nowhere. Capture once stopped for three
// weeks without anyone noticing. Everything worth knowing about -- startup,
// crashes, a clipboard that cannot be read, a failed IPC call -- lands here:
//
//   %APPDATA%\clipcanvas\logs\clipcanvas.log
//
// The file is capped at MAX_BYTES; past that it becomes clipcanvas.old.log
// (replacing the previous one), so the two together never exceed 2 MB.
// Lines are still echoed to the console, for `npm run dev`.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 1024 * 1024;
const CHECK_EVERY = 200; // lines between size checks

let file = null;
let written = 0;

/** Start writing to <dir>/clipcanvas.log. Until called, lines go to the console only. */
function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "clipcanvas.log");
    rotateIfBig();
  } catch (err) {
    file = null;
    console.error("[clipcanvas] cannot write a log file:", err.message);
  }
}

function rotateIfBig() {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, file.replace(/\.log$/, ".old.log"));
    }
  } catch (_) {
    // No file yet: nothing to rotate.
  }
}

function write(level, args) {
  const text = args.map(format).join(" ");
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)("[clipcanvas] " + text);
  if (!file) return;
  try {
    if (++written % CHECK_EVERY === 0) rotateIfBig();
    fs.appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`);
  } catch (_) {
    // A log that cannot be written must never take the app down with it.
  }
}

function format(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (v && typeof v === "object") {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

module.exports = {
  init,
  info: (...a) => write("info", a),
  warn: (...a) => write("warn", a),
  error: (...a) => write("error", a),
  /** Path of the current log file, or null before init(). */
  get file() { return file; },
};
