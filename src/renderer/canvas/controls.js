// ─── src/renderer/canvas/controls.js ─────────────────────────────────────────
// Flying around the Time Canvas.
//
// What makes the reference feel like flight rather than like a map viewer is
// that nothing snaps: zoom eases toward where the wheel asked for, a released
// drag keeps drifting, and moving between levels is an animated camera move.
//
//   wheel / pinch    smooth zoom toward the cursor
//   drag             pan, with inertia when released while moving
//   click            select a clip
//   double-click     fly into the box under the cursor
//   right-click      fly back out one level
//   F / Home         fit everything        + / -   zoom        arrows   pan
//   Backspace        fly out one level
//
// Wheel direction is unchanged from the DOM version (deltaY > 0 zooms out),
// which is what scratch/verify-time-zoom.js asserts.
// ─────────────────────────────────────────────────────────────────────────────

const DBL_MS = 320;
const WHEEL_K = 0.0017;      // zoom per pixel of wheel delta
const PINCH_K = 0.012;       // trackpad pinch arrives as ctrl+wheel, in small deltas
const ZOOM_EASE = 0.3;       // share of the remaining (log) distance covered per frame
const INERTIA_DECAY = 0.92;  // velocity kept per 16ms after a fling
const KEY_ZOOM = 1.6;
const KEY_PAN = 0.18;        // share of the viewport per arrow press

class Controls {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Viewport} vp
   * @param {object} hooks  { onChange, getTree, pick, onPick, onHover }
   */
  constructor(canvas, vp, hooks = {}) {
    this.canvas = canvas;
    this.vp = vp;
    this.hooks = hooks;
    this.dragging = false;
    this.moved = 0;
    this.last = { x: 0, y: 0 };
    this.lastT = 0;
    this.vel = { x: 0, y: 0 };
    this.lastClick = { t: 0, x: 0, y: 0 };
    this.lastPointer = null;
    this.zoomTarget = null;
    this.zoomAnchor = null;
    this.zoomRaf = null;
    this.inertiaRaf = null;
    this.hoverRaf = null;
    this.anim = null;
    this.bind();
  }

  bind() {
    const c = this.canvas;
    this._wheel = (e) => this.onWheel(e);
    this._down = (e) => this.onDown(e);
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
    this._leave = () => this.onLeave();
    this._menu = (e) => { e.preventDefault(); this.flyOut(this.local(e)); };
    this._key = (e) => this.onKey(e);

    c.addEventListener("wheel", this._wheel, { passive: false });
    c.addEventListener("pointerdown", this._down);
    c.addEventListener("pointerleave", this._leave);
    c.addEventListener("contextmenu", this._menu);
    window.addEventListener("pointermove", this._move);
    window.addEventListener("pointerup", this._up);
    window.addEventListener("keydown", this._key);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener("wheel", this._wheel);
    c.removeEventListener("pointerdown", this._down);
    c.removeEventListener("pointerleave", this._leave);
    c.removeEventListener("contextmenu", this._menu);
    window.removeEventListener("pointermove", this._move);
    window.removeEventListener("pointerup", this._up);
    window.removeEventListener("keydown", this._key);
    this.stopAll();
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  tree() { return this.hooks.getTree ? this.hooks.getTree() : null; }

  // ── Smooth zoom ────────────────────────────────────────────────────────────
  onWheel(e) {
    e.preventDefault();
    this.cancelAnim();
    this.stopInertia();

    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;             // lines
    else if (e.deltaMode === 2) dy *= this.vp.height; // pages

    const k = e.ctrlKey ? PINCH_K : WHEEL_K;
    this.zoomToward(Math.exp(-dy * k), this.local(e));
  }

  /** Accumulate a zoom request and ease toward it, anchored at `p`. */
  zoomToward(factor, p) {
    const base = this.zoomTarget != null ? this.zoomTarget : this.vp.scale;
    this.zoomTarget = clamp(base * factor, this.vp.minScale, this.vp.maxScale);
    this.zoomAnchor = p;
    if (this.zoomRaf == null) this.zoomRaf = requestAnimationFrame(() => this.zoomStep());
  }

  zoomStep() {
    this.zoomRaf = null;
    if (this.zoomTarget == null) return;

    const cur = this.vp.scale;
    const tgt = this.zoomTarget;
    const d = Math.log(tgt) - Math.log(cur);
    // Easing in LOG space keeps the apparent speed constant at every depth.
    const next = Math.abs(d) < 0.002 ? tgt : Math.exp(Math.log(cur) + d * ZOOM_EASE);

    this.vp.zoomAt(this.zoomAnchor.x, this.zoomAnchor.y, next / cur);
    this.changed();

    const clamped = next >= this.vp.maxScale || next <= this.vp.minScale;
    if (next === tgt || clamped) { this.zoomTarget = null; return; }
    this.zoomRaf = requestAnimationFrame(() => this.zoomStep());
  }

  // ── Drag with inertia ──────────────────────────────────────────────────────
  onDown(e) {
    if (e.button !== 0) return;
    this.stopAll();
    this.dragging = true;
    this.moved = 0;
    this.last = this.local(e);
    this.lastT = performance.now();
    this.vel = { x: 0, y: 0 };
    if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  }

  onMove(e) {
    const p = this.local(e);
    if (!this.dragging) {
      if (e.target === this.canvas) {
        this.lastPointer = p;
        this.scheduleHover();
      }
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - this.lastT);
    const dx = p.x - this.last.x;
    const dy = p.y - this.last.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    // Smoothed px/ms, so one jittery sample at release does not fling you off.
    this.vel.x = this.vel.x * 0.6 + (dx / dt) * 0.4;
    this.vel.y = this.vel.y * 0.6 + (dy / dt) * 0.4;
    this.last = p;
    this.lastT = now;
    this.vp.panBy(dx, dy);
    this.changed();
  }

  onUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = "grab";
    const p = this.local(e);

    if (this.moved > 4) {
      // Only fling if the pointer was still moving when released.
      if (performance.now() - this.lastT < 80) this.startInertia();
      return;
    }

    const node = this.pickAt(p);
    const now = Date.now();
    const dbl = now - this.lastClick.t < DBL_MS &&
                Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) < 8;
    this.lastClick = { t: dbl ? 0 : now, x: p.x, y: p.y };

    if (dbl && node) this.flyTo(node);
    else if (this.hooks.onPick) this.hooks.onPick(node, p);
  }

  startInertia() {
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(48, now - last);
      last = now;
      this.vp.panBy(this.vel.x * dt, this.vel.y * dt);
      this.changed();
      const keep = Math.pow(INERTIA_DECAY, dt / 16);
      this.vel.x *= keep;
      this.vel.y *= keep;
      if (Math.hypot(this.vel.x, this.vel.y) < 0.02) { this.inertiaRaf = null; return; }
      this.inertiaRaf = requestAnimationFrame(tick);
    };
    this.inertiaRaf = requestAnimationFrame(tick);
  }

  stopInertia() {
    if (this.inertiaRaf != null) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = null;
  }

  // ── Hover ──────────────────────────────────────────────────────────────────
  /** Coalesced to one pick per frame -- pointermove can fire far faster. */
  scheduleHover() {
    if (this.hoverRaf != null || !this.hooks.onHover) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = null;
      if (this.lastPointer && !this.dragging) this.hooks.onHover(this.pickAt(this.lastPointer));
    });
  }

  onLeave() {
    this.lastPointer = null;
    if (this.hooks.onHover) this.hooks.onHover(null);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  onKey(e) {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const center = { x: this.vp.width / 2, y: this.vp.height / 2 };
    switch (e.key) {
      case "f": case "F": case "Home": {
        const tree = this.tree();
        if (tree) this.fit(tree);
        break;
      }
      case "+": case "=": this.zoomToward(KEY_ZOOM, center); break;
      case "-": case "_": this.zoomToward(1 / KEY_ZOOM, center); break;
      case "ArrowLeft": this.panAnimated(this.vp.width * KEY_PAN, 0); break;
      case "ArrowRight": this.panAnimated(-this.vp.width * KEY_PAN, 0); break;
      case "ArrowUp": this.panAnimated(0, this.vp.height * KEY_PAN); break;
      case "ArrowDown": this.panAnimated(0, -this.vp.height * KEY_PAN); break;
      case "Backspace": this.flyOut(); break;
      default: return;
    }
    e.preventDefault();
  }

  panAnimated(dx, dy) {
    const s = this.vp.scale;
    this.animateTo(() => ({ x: this.vp.x - dx / s, y: this.vp.y - dy / s, scale: s }), 220);
  }

  // ── Camera moves ───────────────────────────────────────────────────────────
  pickAt(p) {
    const tree = this.tree();
    if (!tree || !this.hooks.pick) return null;
    return this.hooks.pick(tree, this.vp.toWorldX(p.x), this.vp.toWorldY(p.y));
  }

  fit(node, padding = 30) {
    this.animateTo(() => {
      const snap = this.vp.snapshot();
      this.vp.fitTo({ x0: node.x, y0: node.y, x1: node.x + node.w, y1: node.y + node.h }, padding);
      const target = this.vp.snapshot();
      this.vp.restore(snap);
      return target;
    });
  }

  flyTo(node) { this.fit(node, 24); }

  /**
   * Back out one level: frame the first box around the cursor that does not
   * already fit on screen. From inside a clip that is its hour; from an hour,
   * its day; and so on up to the whole archive.
   */
  flyOut(p) {
    const tree = this.tree();
    if (!tree) return;
    const at = p || { x: this.vp.width / 2, y: this.vp.height / 2 };
    const W = this.vp.width * 1.02;
    const H = this.vp.height * 1.02;
    let target = null;
    for (let a = this.pickAt(at); a; a = a.parent) {
      if (a.w * this.vp.scale > W || a.h * this.vp.scale > H) { target = a; break; }
    }
    this.fit(target || tree);
  }

  /**
   * Ease the viewport to a target. Scale is interpolated in LOG space: a linear
   * lerp crawls at the wide end and lurches at the close end, which is what
   * makes naive zoom animations feel like they overshoot.
   */
  animateTo(computeTarget, ms = 460) {
    this.stopAll();
    const from = this.vp.snapshot();
    const to = computeTarget();
    const t0 = performance.now();

    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * e);
      // Interpolate the CENTRE of the view, not its corner, so the target stays
      // under the eye during the move instead of sliding in from the side.
      const fcx = from.x + this.vp.width / (2 * from.scale);
      const fcy = from.y + this.vp.height / (2 * from.scale);
      const tcx = to.x + this.vp.width / (2 * to.scale);
      const tcy = to.y + this.vp.height / (2 * to.scale);
      const cx = fcx + (tcx - fcx) * e;
      const cy = fcy + (tcy - fcy) * e;
      this.vp.scale = scale;
      this.vp.x = cx - this.vp.width / (2 * scale);
      this.vp.y = cy - this.vp.height / (2 * scale);
      this.changed();
      this.anim = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  cancelAnim() {
    if (this.anim != null) cancelAnimationFrame(this.anim);
    this.anim = null;
  }

  stopAll() {
    this.cancelAnim();
    this.stopInertia();
    if (this.zoomRaf != null) cancelAnimationFrame(this.zoomRaf);
    this.zoomRaf = null;
    this.zoomTarget = null;
  }

  changed() {
    if (this.hooks.onChange) this.hooks.onChange();
    // What is under a still cursor changes when the canvas moves beneath it.
    if (this.lastPointer && !this.dragging) this.scheduleHover();
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

module.exports = { Controls };
