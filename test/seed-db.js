// ─── test/seed-db.js ─────────────────────────────────────────────────────────
// Fills a new database with synthetic clips, so test/verify-app.js can run on
// a fresh clone and in CI, where there is no clipboard history to copy.
//
// The clips come from the demo's generator (demo/mockdata.js): prose, code in
// several languages, links, spread over ten weeks in lumpy working sessions.
// Its images are drawn on a <canvas>, which the main process has not got, so
// image clips get real PNG files here instead -- some wider than a thumbnail,
// some narrower -- written under the storage folder exactly as a capture
// writes them.
//
// Needs Electron's nativeImage, so it runs under Electron, not plain Node.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** The demo's clips, generated outside a browser. */
function mockClips(n) {
  const had = "document" in globalThis;
  const before = globalThis.document;
  // makeImage() only needs a canvas it can draw on and ask for a data URL.
  const anything = new Proxy({}, { get: () => () => {}, set: () => true });
  globalThis.document = { createElement: () => ({ getContext: () => anything, toDataURL: () => "" }) };
  try {
    require("../demo/mockdata.js");
    return globalThis.makeMockClips(n);
  } finally {
    if (had) globalThis.document = before; else delete globalThis.document;
  }
}

/** A flat-coloured picture with a few blocks on it, as PNG bytes. */
function picture(nativeImage, width, height, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const bmp = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, b, g, r) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 4;
        bmp[i] = b; bmp[i + 1] = g; bmp[i + 2] = r; bmp[i + 3] = 255;
      }
    }
  };
  fill(0, 0, width, height, 40 + rnd() * 30, 30 + rnd() * 30, 20 + rnd() * 30);
  for (let k = 0; k < 14; k++) {
    fill(Math.floor(rnd() * width), Math.floor(rnd() * height),
         Math.floor(20 + rnd() * width / 3), Math.floor(10 + rnd() * height / 4),
         80 + rnd() * 160, 80 + rnd() * 160, 80 + rnd() * 160);
  }
  return nativeImage.createFromBitmap(bmp, { width, height }).toPNG();
}

/**
 * @param {ClipDatabase} db          a new, empty database
 * @param {string}       storageDir  its storage folder
 * @param {object}       o
 * @param {object}       o.nativeImage  Electron's nativeImage
 * @param {number}       [o.clips]
 * @returns {{clips: number, images: number, workspaceId: number}}
 */
function seedDatabase(db, storageDir, { nativeImage, clips = 600 } = {}) {
  const workspaceId = db.listWorkspaces()[0].id;
  const at = db.db.prepare(
    "UPDATE clips SET created_at = ?, updated_at = ?, year = ?, month = ?, day = ?, weekday = ?, hour = ? WHERE id = ?"
  );
  const now = Date.now();
  let images = 0;

  db.db.transaction(() => {
    for (const m of mockClips(clips)) {
      let when = new Date(m.created_at);
      // The generator's hours run to 10 PM; nothing can be copied in the future.
      if (when.getTime() > now) when = new Date(now - (60 + (m.id % 3000)) * 1000);

      let row;
      if (m.type === "image") {
        // Every third one small enough to need no thumbnail.
        const [w, h] = images % 3 === 2 ? [320, 200] : [1280, 720];
        const png = picture(nativeImage, w, h, m.id);
        const rel = ["images", String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, "0"),
                     `img-seed-${m.id}.png`].join("/");
        fs.mkdirSync(path.dirname(path.join(storageDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(storageDir, rel), png);
        row = db.addClip({
          type: "image", content: null, workspace_id: workspaceId, source: "clipboard",
          storage_mode: "local", asset_path: rel, mime_type: "image/png",
          asset_hash: crypto.createHash("sha1").update(png).digest("hex"),
          file_size_bytes: png.length, title: `Image ${w}x${h}`,
        });
        images++;
      } else {
        row = db.addClip({ type: m.type, content: m.content, workspace_id: workspaceId, source: "clipboard" });
      }
      const s = Math.floor(when.getTime() / 1000);
      at.run(s, s, when.getFullYear(), when.getMonth() + 1, when.getDate(), when.getDay(), when.getHours(), row.id);
    }
  })();

  return { clips, images, workspaceId };
}

module.exports = { seedDatabase };
