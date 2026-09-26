// ─── scratch/verify-clipwatch.js ─────────────────────────────────────────────
// Checks for src/main/clipwatch.js, the clipboard watcher, against a fake
// clipboard -- so on plain Node, with no Electron and no real clipboard:
//
//   - a new copy is captured once; what was on the clipboard at launch is not
//   - an image copied again (same pixels) is not captured twice
//   - copies marked private by a password manager are never captured
//   - nothing is read while paused, and resuming skips what was copied meanwhile
//   - ClipCanvas's own copy-back is not captured
//   - a failed read is retried, not skipped; capture is reported broken after
//     FAIL_ALERT failures in a row, and working again when it recovers
//   - without the sequence number, polling by reading still captures text
//
// Usage:  node scratch/verify-clipwatch.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const { ClipboardWatcher, FAIL_ALERT } = require(path.join(__dirname, "..", "src", "main", "clipwatch.js"));

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};

// ── A fake of the parts of Electron's clipboard the watcher uses ────────────
function fakeClipboard() {
  const cb = {
    seq: 0, text: "", formats: [], extra: {}, image: null, locked: false,
    readText() { if (this.locked) throw new Error("clipboard locked"); return this.text; },
    availableFormats() { if (this.locked) throw new Error("clipboard locked"); return this.formats; },
    has(f) { return f in this.extra; },
    readBuffer(f) { return this.extra[f] || Buffer.alloc(0); },
    readImage() { return this.image || { isEmpty: () => true }; },
    writeText(t) { this.copyText(t); },

    copyText(t, extra = {}) {
      this.text = t; this.formats = ["text/plain"]; this.extra = extra; this.image = null; this.seq++;
    },
    copyImage(w, h, fill) {
      const bmp = Buffer.alloc(w * h * 4, fill);
      this.image = { isEmpty: () => false, getSize: () => ({ width: w, height: h }), toBitmap: () => bmp };
      this.text = ""; this.formats = ["image/png"]; this.extra = {}; this.seq++;
    },
  };
  return cb;
}

function watcherOn(cb, opts = {}) {
  const got = { text: [], images: 0, health: [] };
  const w = new ClipboardWatcher({
    clipboard: cb,
    onText: (t) => got.text.push(t),
    onImage: () => got.images++,
    onHealth: (h) => got.health.push(h),
    sequence: "sequence" in opts ? opts.sequence : () => cb.seq,
  });
  w.prime(); // what start() does, without the timer
  return { w, got };
}

// The watcher logs failures; keep that noise out of this report.
function quietly(fn) {
  const saved = [console.error, console.log, console.warn];
  console.error = console.log = console.warn = () => {};
  try { return fn(); } finally { [console.error, console.log, console.warn] = saved; }
}

console.log("\n-- capturing --");
{
  const cb = fakeClipboard();
  cb.copyText("already there at launch");
  const { w, got } = watcherOn(cb);
  w.tick();
  ok("what was on the clipboard at launch is not captured", got.text.length === 0);
  cb.copyText("first copy");
  w.tick(); w.tick();
  ok("a new copy is captured once", got.text.length === 1 && got.text[0] === "first copy", JSON.stringify(got.text));

  cb.copyImage(40, 30, 7);
  w.tick();
  cb.copyImage(40, 30, 7); // the same picture copied again
  w.tick();
  ok("an image copied again is not captured twice", got.images === 1, `${got.images} captured`);
  cb.copyImage(40, 30, 9);
  w.tick();
  ok("a different image is captured", got.images === 2);
}

console.log("\n-- never captured --");
{
  const cb = fakeClipboard();
  const { w, got } = watcherOn(cb);
  cb.copyText("hunter2", { ExcludeClipboardContentFromMonitorProcessing: Buffer.alloc(0) });
  w.tick();
  cb.copyText("s3cret", { "Clipboard Viewer Ignore": Buffer.alloc(0) });
  w.tick();
  const zero = Buffer.alloc(4); zero.writeUInt32LE(0, 0);
  cb.copyText("p4ss", { CanIncludeInClipboardHistory: zero });
  w.tick();
  ok("copies password managers mark private are skipped", got.text.length === 0, JSON.stringify(got.text));
  const one = Buffer.alloc(4); one.writeUInt32LE(1, 0);
  cb.copyText("allowed in history", { CanIncludeInClipboardHistory: one });
  w.tick();
  ok("CanIncludeInClipboardHistory = 1 is captured", got.text.length === 1);

  w.setPaused(true);
  cb.copyText("copied while paused");
  w.tick();
  w.setPaused(false);
  w.tick();
  ok("nothing is captured while paused, or on resume", got.text.length === 1, JSON.stringify(got.text));

  cb.writeText("copied back from ClipCanvas");
  w.noteOwnWrite();
  w.tick();
  ok("ClipCanvas's own copy-back is not captured", got.text.length === 1);
}

console.log("\n-- when reading fails --");
{
  const cb = fakeClipboard();
  const { w, got } = watcherOn(cb);
  cb.copyText("copied while another app held the clipboard");
  cb.locked = true;
  quietly(() => w.tick());
  cb.locked = false;
  quietly(() => w.tick());
  ok("a failed read is retried on the next poll, not skipped", got.text.length === 1, JSON.stringify(got.text));
  ok("one failure does not report capture as broken", got.health.length === 0, JSON.stringify(got.health));

  // Unchanged clipboards are never read, so it takes a new copy that then
  // cannot be read to make every poll fail.
  cb.copyText("stuck");
  cb.locked = true;
  quietly(() => { for (let i = 0; i < FAIL_ALERT + 20; i++) w.tick(); });
  ok(`capture reported broken after ${FAIL_ALERT} failures in a row, once`,
     got.health.length === 1 && got.health[0] === false, JSON.stringify(got.health));
  cb.locked = false;
  cb.copyText("after recovery");
  quietly(() => w.tick());
  ok("and working again when reading recovers", got.health.join() === "false,true", JSON.stringify(got.health));
  ok("the copy made then is captured", got.text[got.text.length - 1] === "after recovery");
}

console.log("\n-- without the sequence number --");
{
  const cb = fakeClipboard();
  const { w, got } = watcherOn(cb, { sequence: null });
  ok("the watcher knows it is polling by reading", !w.usesSequenceNumber);
  cb.copyText("polled");
  w.tick(); w.tick();
  ok("text is still captured, once", got.text.length === 1 && got.text[0] === "polled", JSON.stringify(got.text));
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
