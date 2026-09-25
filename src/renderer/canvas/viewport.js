// ─── src/renderer/canvas/viewport.js ─────────────────────────────────────────
// World <-> screen transform for the Time Canvas.
//
// World space is layout space in design pixels (see layout.js). Screen space is
// CSS pixels inside the canvas element. `scale` is the world->screen multiplier:
// higher scale = zoomed IN = closer to the clips.
//
// NOTE ON THE ZOOM LABEL: the roadmap (and verify-time-zoom.js) label zoom the
// AutoCAD way, where a HIGHER percentage means zoomed OUT:
//   500% years | 400% months | 300% days | 200% hours | 100% clips
// That is the inverse of `scale`, so the label is derived in lod.js and the two
// must never be conflated. Internally everything uses `scale`.
// ─────────────────────────────────────────────────────────────────────────────

// The canvas is sized from its contents (layout.layoutAuto), so its world
// extent grows with the archive -- 2,000 clips already produce a canvas around
// 356,000 world units wide. Fitting that into an 900px viewport needs a scale
// near 0.0024, so a MIN_SCALE of 0.02 silently clamps "fit everything" and the
// user is left looking at one corner with no way to zoom out. MIN_SCALE has to
// leave headroom for an archive orders of magnitude larger than today's.
const MIN_SCALE = 1e-5;
const MAX_SCALE = 8;

class Viewport {
  constructor({ width = 0, height = 0, scale = 1 } = {}) {
    // Top-left of the viewport in WORLD coordinates.
    this.x = 0;
    this.y = 0;
    this.scale = scale;
    this.width = width;   // CSS px
    this.height = height; // CSS px
    // Per-canvas limits. The ceiling is raised by the layout to whatever zoom
    // makes the smallest text on the canvas readable (layout.layoutAuto ->
    // maxZoom), so every clip can actually be read, not merely be present.
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  // ── Conversions ────────────────────────────────────────────────────────────
  toScreenX(wx) { return (wx - this.x) * this.scale; }
  toScreenY(wy) { return (wy - this.y) * this.scale; }
  toWorldX(sx) { return this.x + sx / this.scale; }
  toWorldY(sy) { return this.y + sy / this.scale; }

  /** Visible world rect. Everything outside this is culled. */
  worldBounds() {
    return {
      x0: this.x,
      y0: this.y,
      x1: this.x + this.width / this.scale,
      y1: this.y + this.height / this.scale,
    };
  }

  // ── Movement ───────────────────────────────────────────────────────────────
  /** Pan by a screen-space delta (what a drag gives you). */
  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
  }

  /**
   * Zoom about a screen anchor, keeping the world point under the cursor
   * pinned. This is what makes wheel-zoom feel like flying at a target
   * instead of drifting away from it.
   */
  zoomAt(sx, sy, factor) {
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    const next = clamp(this.scale * factor, this.minScale, this.maxScale);
    if (next === this.scale) return false;
    this.scale = next;
    // Re-pin: world point (wx, wy) must land back on (sx, sy).
    this.x = wx - sx / this.scale;
    this.y = wy - sy / this.scale;
    return true;
  }

  /** Centre the viewport on a world rect and scale it to fit, with padding. */
  fitTo(rect, padding = 40) {
    const w = Math.max(1, rect.x1 - rect.x0);
    const h = Math.max(1, rect.y1 - rect.y0);
    const sx = (this.width - padding * 2) / w;
    const sy = (this.height - padding * 2) / h;
    this.scale = clamp(Math.min(sx, sy), this.minScale, this.maxScale);
    this.x = rect.x0 - (this.width / this.scale - w) / 2;
    this.y = rect.y0 - (this.height / this.scale - h) / 2;
  }

  /** Snapshot for animated transitions (see controls.js flyTo). */
  snapshot() { return { x: this.x, y: this.y, scale: this.scale }; }
  restore(s) { this.x = s.x; this.y = s.y; this.scale = s.scale; }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

module.exports = { Viewport, MIN_SCALE, MAX_SCALE, clamp };
