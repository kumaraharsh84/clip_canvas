// ─── test/verify-clipwatch.js ─────────────────────────────────────────────
// Checks for src/main/clipwatch.js, the clipboard watcher, against a fake of
// Electron's asynchronous clipboard -- so on plain Node, with no Electron and
// no real clipboard:
//
//   - a new copy is captured once; what was on the clipboard at launch is not
//   - an image copied again (same pixels) is not captured twice
//   - copies marked private by a password manager are never captured, and a
//     clipboard that cannot be asked whether it is private is not read
//   - nothing is read while paused, and resuming skips what was copied meanwhile
//   - ClipCanvas's own copy-back is not captured, even with a poll racing it
//   - polls never overlap, however slow a read is
//   - a failed read is retried, not skipped; capture is reported broken after
//     FAIL_ALERT failures in a row, and working again when it recovers
//   - without the sequence number, polling by reading still captures text
//
// Usage:  node test/verify-clipwatch.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const { ClipboardWatcher, FAIL_ALERT, osFormat } = require(path.join(__dirname, "..", "src", "main", "clipwatch.js"));

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A fake of the parts of Electron's clipboard the watcher uses ────────────
// Every read is a promise, as in Electron 44 and later. `extra` holds Windows
// clipboard formats by their own names; the clipboard lists them the way
// Electron does (osFormat). A picture is "PNG bytes" that decodeImage below
// understands.
function fakeClipboard() {
  const cb = {
    seq: 0, text: "", image: null, extra: {}, reads: 0,
    locked: false,      // every call fails, as when another app holds the clipboard
    hasFails: false,    // only has() fails
    delay: 0,           // how long each call takes

    async wait() {
      if (this.delay) await sleep(this.delay);
      if (this.locked) throw new Error("clipboard locked");
    },
    types() {
      return [].concat(this.text ? ["text/plain"] : [], this.image ? ["image/png"] : [],
                       Object.keys(this.extra).map(osFormat));
    },
    async readText() { await this.wait(); return this.text; },
    async has(type) {
      await this.wait();
      if (this.hasFails) throw new Error("has() failed");
      return this.types().includes(type);
    },
    async read() {
      await this.wait();
      this.reads++;
      const data = { "text/plain": Buffer.from(this.text), "image/png": this.image };
      for (const [name, bytes] of Object.entries(this.extra)) data[osFormat(name)] = bytes;
      return [{ types: this.types(), getType: async (type) => new Blob([data[type]]) }];
    },
    async writeText(t) { await this.wait(); this.copyText(t); },

    copyText(t, extra = {}) { this.text = t; this.image = null; this.extra = extra; this.seq++; },
    copyImage(w, h, fill, text = "") {
      this.image = Buffer.from(JSON.stringify({ w, h, fill }));
      this.text = text; this.extra = {}; this.seq++;
    },
  };
  return cb;
}

/** What nativeImage.createFromBuffer is to the real watcher. */
function decodeImage(bytes) {
  const { w, h, fill } = JSON.parse(bytes.toString());
  const bmp = Buffer.alloc(w * h * 4, fill);
  return { isEmpty: () => false, getSize: () => ({ width: w, height: h }), toBitmap: () => bmp };
}

/** A watcher on `cb` that has taken its first look, as start() makes it. */
async function watcherOn(cb, opts = {}) {
  const got = { text: [], images: 0, png: [], health: [] };
  const w = new ClipboardWatcher({
    clipboard: cb,
    decodeImage,
    onText: (t) => got.text.push(t),
    onImage: (_img, _hash, png) => { got.images++; got.png.push(png); },
    onHealth: (h) => got.health.push(h),
    sequence: "sequence" in opts ? opts.sequence : () => cb.seq,
  });
  if (!opts.unprimed) await w.tick();
  return { w, got };
}

// The watcher logs failures; keep that noise out of this report.
async function quietly(fn) {
  const saved = [console.error, console.log, console.warn];
  console.error = console.log = console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.log, console.warn] = saved; }
}

(async () => {
  console.log("\n-- capturing --");
  {
    const cb = fakeClipboard();
    cb.copyText("already there at launch");
    const { w, got } = await watcherOn(cb);
    await w.tick();
    ok("what was on the clipboard at launch is not captured", got.text.length === 0);
    cb.copyText("first copy");
    await w.tick(); await w.tick();
    ok("a new copy is captured once", got.text.length === 1 && got.text[0] === "first copy", JSON.stringify(got.text));

    cb.copyImage(40, 30, 7);
    await w.tick();
    cb.copyImage(40, 30, 7); // the same picture copied again
    await w.tick();
    ok("an image copied again is not captured twice", got.images === 1, `${got.images} captured`);
    ok("the picture's PNG bytes come with it, to be stored as they are",
       Buffer.isBuffer(got.png[0]) && got.png[0].equals(cb.image));
    cb.copyImage(40, 30, 9, "a caption some apps copy with the picture");
    await w.tick();
    ok("a different image is captured, and the text beside it is not", got.images === 2 && got.text.length === 1);
  }

  console.log("\n-- never captured --");
  {
    const cb = fakeClipboard();
    const { w, got } = await watcherOn(cb);
    cb.copyText("hunter2", { ExcludeClipboardContentFromMonitorProcessing: Buffer.alloc(0) });
    await w.tick();
    cb.copyText("s3cret", { "Clipboard Viewer Ignore": Buffer.alloc(0) });
    await w.tick();
    const zero = Buffer.alloc(4); zero.writeUInt32LE(0, 0);
    cb.copyText("p4ss", { CanIncludeInClipboardHistory: zero });
    await w.tick();
    ok("copies password managers mark private are skipped", got.text.length === 0, JSON.stringify(got.text));
    const one = Buffer.alloc(4); one.writeUInt32LE(1, 0);
    cb.copyText("allowed in history", { CanIncludeInClipboardHistory: one });
    await w.tick();
    ok("CanIncludeInClipboardHistory = 1 is captured", got.text.length === 1);

    // If the clipboard cannot say whether a copy is private, it is not read.
    cb.copyText("maybe a secret", { ExcludeClipboardContentFromMonitorProcessing: Buffer.alloc(0) });
    cb.hasFails = true;
    await quietly(() => w.tick());
    cb.hasFails = false;
    await quietly(() => w.tick());
    ok("a copy whose privacy could not be checked is not captured", got.text.length === 1, JSON.stringify(got.text));

    w.setPaused(true);
    cb.copyText("copied while paused");
    await w.tick();
    w.setPaused(false);
    await w.tick(); await w.tick();
    ok("nothing is captured while paused, or on resume", got.text.length === 1, JSON.stringify(got.text));
    cb.copyText("copied after resuming");
    await w.tick();
    ok("capture carries on after resuming", got.text.length === 2);

    await w.ownWrite(() => cb.writeText("copied back from ClipCanvas"));
    await w.tick();
    ok("ClipCanvas's own copy-back is not captured", got.text.length === 2, JSON.stringify(got.text));
  }

  console.log("\n-- a slow clipboard --");
  {
    const cb = fakeClipboard();
    const { w, got } = await watcherOn(cb);
    cb.delay = 15;
    cb.copyText("read slowly");
    const reads = cb.reads;
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    ok("polls do not overlap: three ticks during one slow read capture once",
       got.text.length === 1 && cb.reads === reads + 1, `${got.text.length} captured, ${cb.reads - reads} read`);

    const written = w.ownWrite(() => cb.writeText("copied back, slowly"));
    const racing = w.tick(); // arrives while the write is still in progress
    await Promise.all([written, racing]);
    await w.tick();
    ok("a poll that races a copy-back does not capture it", got.text.length === 1, JSON.stringify(got.text));

    cb.delay = 0;
    let failed = null;
    await w.ownWrite(async () => { throw new Error("could not write"); }).catch((err) => { failed = err; });
    cb.copyText("copied after a failed copy-back");
    await w.tick(); await w.tick();
    ok("a copy-back that fails says so, and capture carries on",
       !!failed && got.text[got.text.length - 1] === "copied after a failed copy-back", JSON.stringify(got.text));
  }

  console.log("\n-- when reading fails --");
  {
    const cb = fakeClipboard();
    const { w, got } = await watcherOn(cb);
    cb.copyText("copied while another app held the clipboard");
    cb.locked = true;
    await quietly(() => w.tick());
    cb.locked = false;
    await quietly(() => w.tick());
    ok("a failed read is retried on the next poll, not skipped", got.text.length === 1, JSON.stringify(got.text));
    ok("one failure does not report capture as broken", got.health.length === 0, JSON.stringify(got.health));

    // Unchanged clipboards are never read, so it takes a new copy that then
    // cannot be read to make every poll fail.
    cb.copyText("stuck");
    cb.locked = true;
    await quietly(async () => { for (let i = 0; i < FAIL_ALERT + 20; i++) await w.tick(); });
    ok(`capture reported broken after ${FAIL_ALERT} failures in a row, once`,
       got.health.length === 1 && got.health[0] === false, JSON.stringify(got.health));
    cb.locked = false;
    cb.copyText("after recovery");
    await quietly(() => w.tick());
    ok("and working again when reading recovers", got.health.join() === "false,true", JSON.stringify(got.health));
    ok("the copy made then is captured", got.text[got.text.length - 1] === "after recovery");
  }
  {
    // The very first look fails: what was there at launch must still not be captured.
    const cb = fakeClipboard();
    cb.copyText("there at launch, behind a locked clipboard");
    cb.locked = true;
    const { w, got } = await watcherOn(cb, { unprimed: true });
    await quietly(() => w.tick());
    cb.locked = false;
    await quietly(() => w.tick());
    await w.tick();
    ok("a clipboard that could not be read at launch is noted later, not captured", got.text.length === 0, JSON.stringify(got.text));
    cb.copyText("the first real copy");
    await w.tick();
    ok("and the first copy after that is captured", got.text.length === 1 && got.text[0] === "the first real copy");
  }
  {
    // Bytes that claim to be a picture and are not.
    const cb = fakeClipboard();
    const { w, got } = await watcherOn(cb);
    cb.copyText("text beside a broken picture");
    cb.image = Buffer.from("not a picture");
    await w.tick();
    ok("a picture that does not decode is left, and its text captured", got.images === 0 && got.text.length === 1);
  }

  console.log("\n-- on a clipboard API it does not know --");
  {
    // Electron 43 and earlier: synchronous, with readImage and friends.
    const sync = { readText: () => "", has: () => false, read: () => "", readImage() {}, availableFormats: () => [] };
    let threw = null;
    try { new ClipboardWatcher({ clipboard: sync, decodeImage, onText() {}, onImage() {}, sequence: null }); }
    catch (err) { threw = err; }
    ok("the watcher refuses the synchronous clipboard, saying which Electron it needs",
       !!threw && /synchronous/.test(threw.message) && /Electron 44/.test(threw.message), threw && threw.message);
    threw = null;
    try { new ClipboardWatcher({ clipboard: { readText: async () => "" }, decodeImage, onText() {}, onImage() {}, sequence: null }); }
    catch (err) { threw = err; }
    ok("and one with calls missing, naming them", !!threw && /read, has/.test(threw.message), threw && threw.message);
  }

  console.log("\n-- without the sequence number --");
  {
    const cb = fakeClipboard();
    const { w, got } = await watcherOn(cb, { sequence: null });
    ok("the watcher knows it is polling by reading", !w.usesSequenceNumber);
    cb.copyText("polled");
    await w.tick(); await w.tick();
    ok("text is still captured, once", got.text.length === 1 && got.text[0] === "polled", JSON.stringify(got.text));
  }

  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
