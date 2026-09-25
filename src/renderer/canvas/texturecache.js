// ─── src/renderer/canvas/texturecache.js ─────────────────────────────────────
// Pre-painted line textures for clip cards.
//
// Zoomed out, the reference is a field of boxes each filled with faint coloured
// lines. Painting those lines directly every frame is the expensive way: a few
// hundred cards times dozens of lines times several tokens is tens of thousands
// of rectangles per frame. Instead each card's text is painted ONCE into a
// small bitmap at roughly its on-screen size, and every later frame is a single
// drawImage per card.
//
// Sizes are powers of two, so a zoom nudge reuses the bitmap already made and
// only a real change of scale paints a new one. The budget is in bytes, not
// entries, because a 16px texture and a 512px texture differ by 1000x.
// ─────────────────────────────────────────────────────────────────────────────

const { LRU } = require("./lru");

const HAS_OFFSCREEN = typeof OffscreenCanvas !== "undefined";

class TextureCache {
  constructor({ budgetBytes = 80 * 1024 * 1024 } = {}) {
    this.cache = new LRU({
      maxCost: budgetBytes,
      onEvict: (_k, v) => { if (v && typeof v.close === "function") v.close(); },
    });
    this.sizes = new Map(); // key -> Set of sizes painted, to find a stand-in
    this.made = 0;
  }

  get(key, size) {
    return this.cache.get(key + "@" + size) || null;
  }

  /**
   * Any size already painted for this key. Drawn scaled while the right size is
   * waiting for frame budget -- a slightly soft texture beats a blank card.
   */
  getAny(key) {
    const set = this.sizes.get(key);
    if (!set) return null;
    let best = null;
    let bestSize = 0;
    for (const size of set) {
      const bmp = this.cache.get(key + "@" + size);
      if (!bmp) { set.delete(size); continue; }
      if (size > bestSize) { best = bmp; bestSize = size; }
    }
    return best;
  }

  /** Paint and cache a texture. `paint(ctx, w, h)` draws into a blank canvas. */
  make(key, size, w, h, paint) {
    let surface;
    if (HAS_OFFSCREEN) {
      surface = new OffscreenCanvas(w, h);
    } else {
      surface = document.createElement("canvas");
      surface.width = w;
      surface.height = h;
    }
    paint(surface.getContext("2d"), w, h);

    // An ImageBitmap is the fastest thing to drawImage; fall back to the canvas.
    const bmp = HAS_OFFSCREEN && surface.transferToImageBitmap
      ? surface.transferToImageBitmap()
      : surface;

    this.cache.set(key + "@" + size, bmp, w * h * 4);
    let set = this.sizes.get(key);
    if (!set) this.sizes.set(key, (set = new Set()));
    set.add(size);
    this.made++;
    return bmp;
  }

  clear() {
    this.cache.clear();
    this.sizes.clear();
  }

  stats() {
    return { ...this.cache.stats(), made: this.made };
  }
}

module.exports = { TextureCache };
