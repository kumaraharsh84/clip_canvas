// ─── src/main/clipwatch.js ───────────────────────────────────────────────────
// Notices new clipboard contents, and skips the ones that ask not to be kept.
//
// WHY A SEQUENCE NUMBER
// Electron has no clipboard-change event, so this polls. Polling by reading
// the clipboard is expensive once an image is on it, and an idle clipboard
// should cost nothing.
//
// Windows counts every clipboard change: GetClipboardSequenceNumber() costs
// about a microsecond. Polling THAT, and reading the clipboard only when it
// moves, makes an idle poll free. It is called through koffi, a Node-API FFI:
// Node-API modules are ABI-stable, so unlike better-sqlite3 it does not need
// rebuilding for each Electron version. Without it (not Windows, or koffi
// failed to load) the watcher falls back to reading, and reads images only
// every IMAGE_FALLBACK_MS.
//
// THE CLIPBOARD IS ASYNCHRONOUS
// Since Electron 44 every read is a promise (the API is modelled on the web's:
// read() gives items, each with its types and a getType() for the bytes). Two
// things follow, and both are handled in serial():
//   - a poll that is still reading must not be joined by the next one, or the
//     same copy is captured twice;
//   - ClipCanvas's own write (Copy back) and the look at the clipboard right
//     after it must not have a poll between them, or the app captures what it
//     just wrote.
// So everything that touches the clipboard runs one after another, in order.
//
// WHAT IS NEVER CAPTURED
// ClipCanvas keeps everything, forever. Password managers and other apps mark
// secrets so clipboard tools skip them, and this honours those marks:
//   ExcludeClipboardContentFromMonitorProcessing   any data: do not look at it
//   Clipboard Viewer Ignore                        older convention, same meaning
//   CanIncludeInClipboardHistory = 0 (a DWORD)     keep it out of history
// These are the formats Windows' own clipboard history respects. They are
// Windows clipboard formats, not MIME types; Electron shows such a format as
//   electron application/osclipboard;format="<name>"
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
const ASYNC_API = ["read", "readText", "has"]; // what this file calls
const FAIL_ALERT = 5;   // failed polls in a row before capture counts as broken (~3.5 s)
const LOG_EVERY = 100;  // while failing, log every Nth failure, not every one

/** A Windows clipboard format, as Electron's clipboard names it. */
function osFormat(name) {
  return `electron application/osclipboard;format="${name}"`;
}

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

/**
 * Throws, saying why, if `clipboard` is not the asynchronous API of Electron
 * 44 and later. On the synchronous one (43 and earlier) readText() returns a
 * string and read() takes a format: every await here would "work" and capture
 * nothing, so refuse to start instead. Only the shape is looked at -- the
 * clipboard itself is not read.
 */
function assertAsyncClipboard(clipboard) {
  const missing = ASYNC_API.filter((k) => typeof clipboard[k] !== "function");
  if (missing.length) throw new Error(`this Electron's clipboard has no ${missing.join(", ")}`);
  if (typeof clipboard.readImage === "function") {
    throw new Error("this Electron's clipboard is the synchronous one (Electron 43 or earlier): " +
      "clipwatch.js needs the asynchronous clipboard of Electron 44 and later");
  }
}

const sameFormat = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The bytes of one type of one clipboard item. */
async function bytesOf(item, type) {
  return Buffer.from(await (await item.getType(type)).arrayBuffer());
}

/**
 * Has whatever is on the clipboard asked not to be recorded? `items` is what
 * clipboard.read() gave, if the caller already has it. If the clipboard cannot
 * be asked, this throws rather than answer "no": the poll fails and is tried
 * again, which is the safe way round for a secret.
 */
async function isPrivate(clipboard, items = null) {
  for (const f of IGNORE_FORMATS) if (await clipboard.has(osFormat(f))) return true;
  const flag = osFormat(HISTORY_FORMAT);
  if (!(await clipboard.has(flag))) return false;
  for (const item of items || await clipboard.read()) {
    const type = item.types.find((t) => sameFormat(t, flag));
    if (!type) continue;
    const value = await bytesOf(item, type);
    return value.length >= 4 && value.readUInt32LE(0) === 0;
  }
  return false;
}

/** Identity of an image: its size and raw pixels. */
function imageHash(img) {
  const { width, height } = img.getSize();
  return crypto.createHash("sha1").update(width + "x" + height + ":").update(img.toBitmap()).digest("hex");
}

class ClipboardWatcher {
  /**
   * @param {object}   o
   * @param {object}   o.clipboard    Electron's clipboard module (44 or later)
   * @param {function} o.decodeImage  (pngBuffer) => nativeImage -- Electron's
   *                                  nativeImage.createFromBuffer, passed in so
   *                                  this file needs no Electron of its own
   * @param {function} o.onText       (text) => void
   * @param {function} o.onImage      (nativeImage, hash, pngBuffer) => void
   * @param {function} [o.onHealth]   (ok) => void -- false after FAIL_ALERT failed
   *                                  polls in a row, true once polling recovers
   * @param {number}   [o.intervalMs]
   */
  constructor({ clipboard, decodeImage, onText, onImage, onHealth = null, intervalMs = 700, sequence = loadSequenceNumber() }) {
    assertAsyncClipboard(clipboard);
    this.cb = clipboard;
    this.decodeImage = decodeImage;
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
    this.primed = false;   // the clipboard as it is has been noted, and is not a new copy
    this.ticking = false;  // a poll is waiting or reading
    this.chain = Promise.resolve();
    this.timer = null;
  }

  get usesSequenceNumber() { return !!this.seq; }

  /**
   * Whatever is already on the clipboard at launch is not a new copy: the
   * first tick notes it (see tick) before any poll looks for one.
   */
  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    return this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** While paused nothing is read; on resume, what was copied meanwhile is skipped. */
  setPaused(paused) {
    const was = this.paused;
    this.paused = !!paused;
    if (was && !this.paused) this.primed = false;
  }

  /**
   * Do a clipboard write of ClipCanvas's own (Copy back), then note the
   * clipboard as it then is -- with no poll in between, so the write is not
   * captured as a new clip.
   * @param {function} write  async () => void
   */
  ownWrite(write) {
    return this.serial(async () => {
      await write();       // if this throws nothing was written: polling carries on as it was
      this.primed = false; // if noting fails, the next tick notes instead of polling
      await this.prime();
    });
  }

  /** Run `fn` after everything queued before it, whether or not that failed. */
  serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Note the clipboard as it is now, without capturing it. */
  async prime() {
    const s = this.seq ? this.seq() : null;
    const seen = await this.look();
    if (!seen.private) { // never hold a secret, not even to compare
      this.lastText = (await this.cb.readText()) || null;
      const image = await this.imageOf(seen);
      this.lastImageHash = image ? imageHash(image.img) : null;
    }
    if (s !== null) this.lastSeq = s;
    this.primed = true;
  }

  /**
   * One poll. Never overlaps another: a tick that arrives while one is still
   * waiting or reading does nothing. Resolves when this poll is done; never
   * rejects.
   */
  tick() {
    if (this.paused || this.ticking) return Promise.resolve();
    this.ticking = true;
    return this.serial(async () => {
      try {
        if (this.paused) return;
        if (this.primed) await this.poll(); else await this.prime();
        if (this.failures) this.recovered();
      } catch (err) {
        this.failed(err);
      } finally {
        this.ticking = false;
      }
    });
  }

  async poll() {
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
    await this.read(imageDue);
    // Only after a successful read: if it threw, the next poll tries again.
    if (s !== null) this.lastSeq = s;
  }

  /** What is on the clipboard: whether it is private, and its image if any. */
  async look() {
    const items = await this.cb.read();
    if (await isPrivate(this.cb, items)) return { private: true };
    for (const item of items) {
      const type = item.types.find((t) => t === "image/png") || item.types.find((t) => t.startsWith("image/"));
      if (type) return { private: false, item, type };
    }
    return { private: false };
  }

  /**
   * The picture `look` found, decoded -- and its bytes when they are PNG, so
   * storing it need not encode it again. Or null.
   */
  async imageOf(seen) {
    if (!seen.item) return null;
    const bytes = await bytesOf(seen.item, seen.type);
    let img;
    // Bytes that do not decode are not a picture to keep; the text beside
    // them, if any, still is.
    try { img = this.decodeImage(bytes); } catch (_) { img = null; }
    if (!img || img.isEmpty()) return null;
    return { img, png: seen.type === "image/png" ? bytes : null };
  }

  async read(imageDue) {
    const seen = await this.look();
    if (seen.private) return;

    // Images first: copying an image often leaves a text representation too
    // (a filename, or HTML), and capturing that instead loses the picture.
    if (seen.item) {
      if (!imageDue) return;
      const image = await this.imageOf(seen);
      if (image) {
        const hash = imageHash(image.img);
        if (hash !== this.lastImageHash) {
          this.lastImageHash = hash;
          this.lastText = (await this.cb.readText()) || this.lastText;
          await this.onImage(image.img, hash, image.png);
        }
        return;
      }
    }

    const text = await this.cb.readText();
    if (text && text !== this.lastText) {
      this.lastText = text;
      this.lastImageHash = null;
      await this.onText(text);
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
  ClipboardWatcher, isPrivate, imageHash, loadSequenceNumber, assertAsyncClipboard, osFormat,
  IGNORE_FORMATS, HISTORY_FORMAT, FAIL_ALERT,
};
