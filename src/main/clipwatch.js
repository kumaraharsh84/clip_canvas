// ─── src/main/clipwatch.js ───────────────────────────────────────────────────
// Notices new clipboard contents, and skips the ones that ask not to be kept.
//
// WHY A SEQUENCE NUMBER
// Electron has no clipboard-change event, so this polls. Polling by reading
// the clipboard is expensive once an image is on it: measured on a 2560x1440
// image, readImage() alone is ~145 ms, and the old check -- readImage, encode
// to PNG, hash -- was ~440 ms, every 700 ms, for as long as the image stayed
// copied (most of a CPU core, on the thread that answers the UI).
//
// Windows counts every clipboard change: GetClipboardSequenceNumber() costs
// about a microsecond. Polling THAT, and reading the clipboard only when it
// moves, makes an idle poll free. It is called through koffi, a Node-API FFI:
// Node-API modules are ABI-stable, so unlike better-sqlite3 it does not need
// rebuilding for each Electron version. Without it (not Windows, or koffi
// failed to load) the watcher falls back to reading, and reads images only
// every IMAGE_FALLBACK_MS.
//
// WHAT IS NEVER CAPTURED
// ClipCanvas keeps everything, forever. Password managers and other apps mark
// secrets so clipboard tools skip them, and this honours those marks:
//   ExcludeClipboardContentFromMonitorProcessing   any data: do not look at it
//   Clipboard Viewer Ignore                        older convention, same meaning
//   CanIncludeInClipboardHistory = 0 (a DWORD)     keep it out of history
// These are the formats Windows' own clipboard history respects.
//
// WHEN READING FAILS
// A failed poll is retried on the next one (the sequence number is recorded
// only after a successful read, so a clipboard another app had locked for a
// moment is not skipped). Failures are logged once, then every LOG_EVERY;
// after FAIL_ALERT in a row the watcher reports itself unhealthy (onHealth),
// and main.js shows it in the tray and the window, and again on recovery.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const log = require("./log");

const IGNORE_FORMATS = ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"];
const HISTORY_FORMAT = "CanIncludeInClipboardHistory";
const IMAGE_FALLBACK_MS = 3000;
const FAIL_ALERT = 5;   // failed polls in a row before capture counts as broken (~3.5 s)
const LOG_EVERY = 100;  // while failing, log every Nth failure, not every one

/** GetClipboardSequenceNumber, or null where it cannot be had. */
function loadSequenceNumber() {
  if (process.platform !== "win32") return null;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const fn = user32.func("uint32 __stdcall GetClipboardSequenceNumber()");
    fn();
    return fn;
  } catch (err) {
    log.warn("clipboard sequence number unavailable, polling instead:", err.message);
    return null;
  }
}

/** Has whatever is on the clipboard asked not to be recorded? */
function isPrivate(clipboard) {
  try {
    for (const f of IGNORE_FORMATS) if (clipboard.has(f)) return true;
    const h = clipboard.readBuffer(HISTORY_FORMAT);
    return h.length >= 4 && h.readUInt32LE(0) === 0;
  } catch (_) {
    return false;
  }
}

/** Identity of an image: its size and raw pixels. No PNG encode needed. */
function imageHash(img) {
  const { width, height } = img.getSize();
  return crypto.createHash("sha1").update(width + "x" + height + ":").update(img.toBitmap()).digest("hex");
}

class ClipboardWatcher {
  /**
   * @param {object}   o
   * @param {object}   o.clipboard  Electron's clipboard module
   * @param {function} o.onText     (text) => void
   * @param {function} o.onImage    (nativeImage, hash) => void
   * @param {function} [o.onHealth] (ok) => void -- false after FAIL_ALERT failed
   *                                polls in a row, true once polling recovers
   * @param {number}   [o.intervalMs]
   */
  constructor({ clipboard, onText, onImage, onHealth = null, intervalMs = 700, sequence = loadSequenceNumber() }) {
    this.cb = clipboard;
    this.onText = onText;
    this.onImage = onImage;
    this.onHealth = onHealth;
    this.failures = 0;
    this.intervalMs = intervalMs;
    this.seq = sequence;
    this.lastSeq = null;
    this.lastText = null;
    this.lastImageHash = null;
    this.lastImageCheck = 0;
    this.paused = false;
    this.timer = null;
  }

  get usesSequenceNumber() { return !!this.seq; }

  start() {
    // Whatever is already on the clipboard at launch is not a new copy.
    this.prime();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** While paused nothing is read; on resume, what was copied meanwhile is skipped. */
  setPaused(paused) {
    const was = this.paused;
    this.paused = !!paused;
    if (was && !this.paused) this.prime();
  }

  /**
   * Call right after ClipCanvas itself writes to the clipboard (copy back), so
   * that write is not captured as a new clip.
   */
  noteOwnWrite() { this.prime(); }

  /** Remember the clipboard as it is now, without capturing it. */
  prime() {
    if (this.seq) this.lastSeq = this.seq();
    if (isPrivate(this.cb)) return; // never hold a secret, not even to compare
    this.lastText = this.cb.readText() || null;
    const img = this.hasImage() ? this.cb.readImage() : null;
    this.lastImageHash = img && !img.isEmpty() ? imageHash(img) : null;
  }

  hasImage() {
    return this.cb.availableFormats().some((f) => f.startsWith("image/"));
  }

  tick() {
    if (this.paused) return;
    try {
      this.poll();
    } catch (err) {
      this.failed(err);
      return;
    }
    if (this.failures) this.recovered();
  }

  poll() {
    let imageDue = true;
    let s = null;
    if (this.seq) {
      s = this.seq();
      if (s === this.lastSeq) return; // nothing new: the common case, ~1 µs
    } else {
      const now = Date.now();
      imageDue = now - this.lastImageCheck >= IMAGE_FALLBACK_MS;
      if (imageDue) this.lastImageCheck = now;
    }
    this.read(imageDue);
    // Only after a successful read: if it threw, the next poll tries again.
    if (s !== null) this.lastSeq = s;
  }

  read(imageDue) {
    if (isPrivate(this.cb)) return;

    // Images first: copying an image often leaves a text representation too
    // (a filename, or HTML), and capturing that instead loses the picture.
    if (this.hasImage()) {
      if (!imageDue) return;
      const img = this.cb.readImage();
      if (!img.isEmpty()) {
        const hash = imageHash(img);
        if (hash !== this.lastImageHash) {
          this.lastImageHash = hash;
          this.lastText = this.cb.readText() || this.lastText;
          this.onImage(img, hash);
        }
        return;
      }
    }

    const text = this.cb.readText();
    if (text && text !== this.lastText) {
      this.lastText = text;
      this.lastImageHash = null;
      this.onText(text);
    }
  }

  failed(err) {
    this.failures++;
    if (this.failures === 1 || this.failures % LOG_EVERY === 0) {
      log.error(`clipboard poll failed (${this.failures} in a row):`, err);
    }
    if (this.failures === FAIL_ALERT && this.onHealth) this.onHealth(false);
  }

  recovered() {
    const was = this.failures;
    this.failures = 0;
    log.info(`clipboard polling recovered after ${was} failed ${was === 1 ? "poll" : "polls"}`);
    if (was >= FAIL_ALERT && this.onHealth) this.onHealth(true);
  }
}

module.exports = {
  ClipboardWatcher, isPrivate, imageHash, loadSequenceNumber,
  IGNORE_FORMATS, HISTORY_FORMAT, FAIL_ALERT,
};
