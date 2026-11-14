// ─── src/main/images.js ──────────────────────────────────────────────────────
// How a captured image is stored: the picture, a thumbnail, and one file for
// identical pictures.
//
// THE PICTURE
// PNG under storage/images/YYYY/MM/, exactly as copied. The database row holds
// its path relative to the storage folder.
//
// THE THUMBNAIL
// Zoomed out, the canvas draws an image a few dozen pixels wide. Decoding a
// 2560x1440 screenshot for that -- and again for each size on the way in --
// is most of what scrolling across a day of screenshots costs. So a copy
// THUMB_WIDTH wide is saved beside it, under storage/thumbs/, and the canvas
// asks for the full picture only when it needs more than that. Images already
// narrower get none: thumbnail_path is "" for "needs none", NULL for "not
// made yet" (images captured before this existed; ThumbnailBackfill makes
// those, one at a time, after launch).
//
// ONE FILE FOR IDENTICAL PICTURES
// Copying the same screenshot twice makes two clips -- every copy has its
// place in time -- but one file: the second clip points at the first one's
// picture and thumbnail. db.emptyTrash() therefore removes a file only when
// the last clip that used it is gone.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const THUMB_WIDTH = 512; // the canvas asks for the full picture above this (renderer.js)

/** images/2026/09/img-x.png -> thumbs/2026/09/img-x.png */
function thumbPathFor(assetRel) {
  const rel = String(assetRel).replace(/\\/g, "/");
  return "thumbs/" + (rel.startsWith("images/") ? rel.slice("images/".length) : rel);
}

/** PNG bytes of `img` at THUMB_WIDTH, or null when it is already that narrow. */
function thumbnailOf(img) {
  if (img.getSize().width <= THUMB_WIDTH) return null;
  return img.resize({ width: THUMB_WIDTH, quality: "good" }).toPNG();
}

function writeFile(storageDir, rel, bytes) {
  const full = path.join(storageDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

/**
 * Store one captured image as a clip.
 * @param {object} o
 * @param {object} o.db          ClipDatabase
 * @param {string} o.storageDir
 * @param {object} o.img         nativeImage, not empty
 * @param {string} o.hash        identity of its pixels (clipwatch.imageHash)
 * @param {number} o.workspaceId
 * @returns {object} the new clip row
 */
function storeImage({ db, storageDir, img, hash, workspaceId }) {
  const { width, height } = img.getSize();
  const clip = {
    type: "image",
    content: null,
    workspace_id: workspaceId,
    source: "clipboard",
    storage_mode: "local",
    asset_hash: hash,
    mime_type: "image/png",
    title: `Image ${width}x${height}`,
  };

  // The same pixels, stored before and still on disk: share that file. This
  // also skips the PNG encode, the slowest part of capturing a screenshot.
  const twin = hash ? db.findImageByHash(hash) : null;
  if (twin && fs.existsSync(path.join(storageDir, twin.asset_path))) {
    return db.addClip({
      ...clip,
      asset_path: twin.asset_path,
      thumbnail_path: twin.thumbnail_path,
      file_size_bytes: twin.file_size_bytes,
    });
  }

  const now = new Date();
  const rel = [
    "images", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"),
    `img-${crypto.randomUUID()}.png`,
  ].join("/");
  const png = img.toPNG();
  writeFile(storageDir, rel, png);

  // A thumbnail that cannot be written must not cost the capture: NULL leaves
  // it to ThumbnailBackfill.
  let thumbRel;
  try {
    const thumb = thumbnailOf(img);
    thumbRel = thumb ? thumbPathFor(rel) : "";
    if (thumb) writeFile(storageDir, thumbRel, thumb);
  } catch (_) {
    thumbRel = null;
  }

  return db.addClip({ ...clip, asset_path: rel, thumbnail_path: thumbRel, file_size_bytes: png.length });
}

/**
 * Makes the thumbnails of images stored before thumbnails existed. One image
 * per tick, newest first, because each one is a full decode on the process
 * that also watches the clipboard; a few hundred images take some minutes
 * after the first launch, and then there is nothing left to do.
 */
class ThumbnailBackfill {
  /**
   * @param {object}   o
   * @param {object}   o.db
   * @param {string}   o.storageDir
   * @param {object}   o.nativeImage  Electron's nativeImage
   * @param {function} [o.onError]    (assetPath, err) => void
   * @param {number}   [o.intervalMs]
   */
  constructor({ db, storageDir, nativeImage, onError = () => {}, intervalMs = 2000 }) {
    this.db = db;
    this.storageDir = storageDir;
    this.nativeImage = nativeImage;
    this.onError = onError;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.made = 0;
  }

  /** Begin after `delayMs`, so launch itself is not slowed down. */
  start(delayMs = 15000) {
    this.stop();
    const tick = () => {
      this.timer = this.step() ? setTimeout(tick, this.intervalMs) : null;
    };
    this.timer = setTimeout(tick, delayMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Decide one image's thumbnail. @returns {boolean} false when none is left */
  step() {
    const row = this.db.nextImageWithoutThumbnail();
    if (!row) return false;

    // "" unless one is made: an unreadable picture must not be retried on
    // every launch for ever.
    let rel = "";
    try {
      const thumbRel = thumbPathFor(row.asset_path);
      if (fs.existsSync(path.join(this.storageDir, thumbRel))) {
        rel = thumbRel; // made for another clip of the same picture
      } else {
        const img = this.nativeImage.createFromPath(path.join(this.storageDir, row.asset_path));
        const thumb = img.isEmpty() ? null : thumbnailOf(img);
        if (thumb) {
          writeFile(this.storageDir, thumbRel, thumb);
          rel = thumbRel;
          this.made++;
        }
      }
    } catch (err) {
      this.onError(row.asset_path, err);
    }
    this.db.setThumbnail(row.id, rel);
    return true;
  }
}

module.exports = { THUMB_WIDTH, thumbPathFor, thumbnailOf, storeImage, ThumbnailBackfill };
