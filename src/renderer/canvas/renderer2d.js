// ─── src/renderer/canvas/renderer2d.js ───────────────────────────────────────
// The canvas-2D painter for the Time Canvas.
//
// A CARD IS READ AT FOUR DISTANCES, AND IS DRAWN DIFFERENTLY AT EACH
//
//   a few px       one solid tile in its category colour. Thousands of these
//                  are the zoomed-out mosaic -- the reference's opening shot.
//   tens of px     its text as a pre-painted texture of coloured dashes, one
//                  drawImage per card (see texturecache.js).
//   lines >= 2.4px the same dashes drawn live, per token, so they stay crisp.
//   font >= 6.5px  real glyphs, syntax-coloured.
//
// None of these ever truncates: every level draws the card's COMPLETE text at
// the card's own font scale (layout.js), only the level of detail changes.
//
// COST IS BOUNDED BY WHAT IS ON SCREEN, NOT BY HOW MUCH YOU HAVE COPIED
//   - off-screen subtrees are rejected with one rectangle test
//   - containers smaller than 3px are one flat rect in the blend of their
//     contents, and are not opened
//   - inside a card, only the lines between the top and bottom of the screen
//     are drawn; a 14,000-line paste costs the ~40 lines you can see
//   - texture painting has a per-frame time budget; cards that miss it show a
//     placeholder and the frame loop comes back for them next frame
// ─────────────────────────────────────────────────────────────────────────────

const { levelForDepth, thumbBudget } = require("./lod");

const THEME = {
  bg: "#0b0f14",
  container: ["#0f141b", "#111821", "#131b25", "#151e29"],
  containerEdge: ["#3a4a5a", "#324252", "#2c3b49", "#283644"],
  label: "#a9bccd",
  labelDim: "#61778b",
  time: "#b8c7d4",
  hover: "#e8f0f6",
  selected: "#ffcc55",
  now: "#39d98a",
};

const FONT_SANS = "system-ui, 'Segoe UI', sans-serif";

// Screen-pixel thresholds for the four distances.
const TEXTURE_MIN_PX = 7;      // card size at which its texture is worth using
const RECURSE_MIN_PX = 3;      // containers below this are not opened

class Renderer2D {
  constructor(canvas, { imageCache = null, textureCache = null, theme = THEME } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.images = imageCache;
    this.textures = textureCache;
    this.theme = theme;
    this.dpr = 1;
    this.selectedKey = null;
    this.hoverKey = null;
    this.nowKey = null;
    this.stats = emptyStats();
  }

  /** Size the backing store for devicePixelRatio; call on resize. */
  resize(cssW, cssH, dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1) {
    const c = this.canvas;
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    c.style.width = cssW + "px";
    c.style.height = cssH + "px";
    this.dpr = dpr;
  }

  draw(tree, vp) {
    const ctx = this.ctx;
    const t0 = performance.now();
    this.stats = emptyStats();
    this.vp = vp;
    this.view = vp.worldBounds();
    this.W = vp.width;
    this.H = vp.height;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, vp.width, vp.height);
    ctx.textBaseline = "top";

    if (tree) this.drawNode(tree);

    const framed = tree ? this.framedNode(tree, vp) : null;
    const level = levelForDepth((framed ? framed.depth : -1) + 1);
    this.stats.level = level.id;
    this.stats.zoomLabel = level.label;
    this.stats.scale = vp.scale;
    this.stats.ms = performance.now() - t0;
    return this.stats;
  }

  drawNode(n) {
    const v = this.view;
    if (n.x > v.x1 || n.y > v.y1 || n.x + n.w < v.x0 || n.y + n.h < v.y0) {
      this.stats.culled++;
      return;
    }
    const s = this.vp.scale;
    const sw = n.w * s;
    const sh = n.h * s;
    if (sw * sh < 0.2) { this.stats.culled++; return; }

    const sx = (n.x - this.vp.x) * s;
    const sy = (n.y - this.vp.y) * s;
    if (n.clip) this.drawCard(n, sx, sy, sw, sh);
    else this.drawContainer(n, sx, sy, sw, sh);
  }

  // ── Containers: year / month / day / hour ──────────────────────────────────
  drawContainer(n, sx, sy, sw, sh) {
    const ctx = this.ctx;
    const d = n.depth < 0 ? 0 : Math.min(3, n.depth);

    if (sw < RECURSE_MIN_PX || sh < RECURSE_MIN_PX) {
      ctx.fillStyle = n.blockColor || this.theme.container[d];
      ctx.fillRect(sx, sy, sw, sh);
      this.stats.collapsed++;
      return;
    }

    if (n.depth >= 0) {
      ctx.fillStyle = this.theme.container[d];
      ctx.fillRect(sx, sy, sw, sh);
      this.stats.boxes++;
    }

    for (const kid of n.children) this.drawNode(kid);

    if (n.depth < 0) return;

    if (sw > 6 && sh > 6) {
      const hovered = this.hoverKey === n.key;
      ctx.strokeStyle = hovered ? this.theme.hover : this.theme.containerEdge[d];
      ctx.lineWidth = hovered ? 1.5 : 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    }

    // The current hour stays marked, per the roadmap.
    if (this.nowKey && n.key === this.nowKey && sw > 4 && sh > 4) {
      ctx.strokeStyle = this.theme.now;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    }

    this.drawContainerLabel(n, sx, sy, sw);
  }

  drawContainerLabel(n, sx, sy, sw) {
    const s = this.vp.scale;
    const hdrPx = n.hdr * s;
    const fontPx = Math.min(hdrPx * 0.62, 34);
    if (fontPx < 7) return;

    const ctx = this.ctx;
    const padPx = n.pad * s;
    const bandH = Math.min(hdrPx, fontPx * 1.7);
    const cy = sy + bandH / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, hdrPx);
    ctx.clip();
    ctx.textBaseline = "middle";

    ctx.font = "600 " + fontPx.toFixed(1) + "px " + FONT_SANS;
    ctx.fillStyle = this.theme.label;
    const label = n.labelLong || n.label;
    ctx.fillText(label, sx + padPx + 2, cy);
    const labelW = ctx.measureText(label).width;

    ctx.font = (fontPx * 0.8).toFixed(1) + "px " + FONT_SANS;
    const badge = n.count.toLocaleString() + (n.count === 1 ? " clip" : " clips");
    const badgeW = ctx.measureText(badge).width;
    if (padPx + labelW + fontPx * 1.5 + badgeW < sw - padPx) {
      ctx.fillStyle = this.theme.labelDim;
      ctx.fillText(badge, sx + sw - padPx - badgeW - 2, cy);
    }

    ctx.restore();
    this.stats.labels++;
  }

  // ── Clip cards ─────────────────────────────────────────────────────────────
  drawCard(n, sx, sy, sw, sh) {
    const ctx = this.ctx;
    const s = this.vp.scale;
    const cat = n.cat;
    this.stats.cards++;

    // Distance 1: a mosaic tile.
    if (sw < TEXTURE_MIN_PX || sh < TEXTURE_MIN_PX) {
      ctx.fillStyle = n.block;
      ctx.fillRect(sx, sy, sw, sh);
      if (this.selectedKey === n.key || this.hoverKey === n.key) {
        ctx.strokeStyle = this.selectedKey === n.key ? this.theme.selected : this.theme.hover;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx - 1, sy - 1, sw + 2, sh + 2);
      }
      return;
    }

    ctx.fillStyle = cat.tint;
    ctx.fillRect(sx, sy, sw, sh);

    const hdrPx = n.hdr * s;
    const padPx = n.pad * s;
    const bx = sx + padPx;
    const by = sy + hdrPx;
    const bw = n.body.w * s;
    const bh = n.body.h * s;

    if (n.clip.type === "image") this.drawImageBody(n, bx, by, bw, bh);

    this.drawCardHeader(n, sx, sy, sw, hdrPx, padPx);

    const selected = this.selectedKey === n.key;
    const hovered = this.hoverKey === n.key;
    if (selected) {
      ctx.strokeStyle = this.theme.selected;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    } else if (hovered) {
      ctx.strokeStyle = this.theme.hover;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx + 0.75, sy + 0.75, sw - 1.5, sh - 1.5);
    } else if (sw > 10 && sh > 10) {
      ctx.strokeStyle = cat.edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    }
  }

  /**
   * Category title on the left, the time it was copied on the right. When the
   * header is too small to read it becomes a coloured dash -- which is how the
   * reference's filenames read from a distance.
   */
  drawCardHeader(n, sx, sy, sw, hdrPx, padPx) {
    if (hdrPx < 1.2) return;
    const ctx = this.ctx;
    const cat = n.cat;
    const fontPx = hdrPx * 0.64;

    if (fontPx < 7) {
      ctx.fillStyle = cat.edge;
      ctx.fillRect(
        sx + padPx, sy + hdrPx * 0.3,
        Math.max(1, (sw - 2 * padPx) * n.titleFrac), Math.max(0.8, hdrPx * 0.4)
      );
      return;
    }

    // The band is capped in SCREEN pixels. Zoomed deep into a card, its world
    // header can be 100+ px tall; a label strip that size is just a slab of
    // colour. Past the cap the rest of the header is plain card, i.e. margin.
    const px = Math.min(fontPx, 22);
    const bandH = Math.min(hdrPx, px * 1.9);
    ctx.fillStyle = cat.head;
    ctx.fillRect(sx, sy, sw, bandH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, bandH);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.font = px.toFixed(1) + "px " + FONT_SANS;
    const cy = sy + bandH / 2;
    let room = sw - padPx * 2;

    // The timestamp wins the space fight: a clipped title is a small loss, a
    // missing time defeats the point of a time canvas.
    if (n.timeLabel) {
      const tw = ctx.measureText(n.timeLabel).width;
      if (tw + px < room) {
        ctx.fillStyle = this.theme.time;
        ctx.fillText(n.timeLabel, sx + sw - padPx - tw, cy);
        room -= tw + px * 0.8;
      }
    }
    if (room > px) {
      ctx.beginPath();
      ctx.rect(sx + padPx, sy, room, bandH);
      ctx.clip();
      ctx.fillStyle = cat.ink;
      ctx.fillText(n.headerText, sx + padPx, cy);
    }
    ctx.restore();
    this.stats.labels++;
  }

  drawImageBody(n, bx, by, bw, bh) {
    const ctx = this.ctx;
    if (!this.images || bw < 10 || bh < 10) {
      ctx.fillStyle = n.cat.faint;
      ctx.fillRect(bx, by, bw, bh);
      return;
    }
    const bmp = this.images.get(n.clip, thumbBudget({ w: n.body.w, h: n.body.h }, this.vp.scale));
    if (!bmp) {
      ctx.fillStyle = n.cat.faint;
      ctx.fillRect(bx, by, bw, bh);
      this.stats.thumbPending++;
      return;
    }
    const ar = bmp.width / bmp.height;
    let dw = bw;
    let dh = bw / ar;
    if (dh > bh) { dh = bh; dw = bh * ar; }
    ctx.drawImage(bmp, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
    this.stats.thumbs++;
  }

  // ── Queries ────────────────────────────────────────────────────────────────
  /**
   * The box that currently frames the view: the deepest node containing the
   * centre of the screen that still spans at least half of it.
   */
  framedNode(tree, vp) {
    const cx = vp.x + vp.width / (2 * vp.scale);
    const cy = vp.y + vp.height / (2 * vp.scale);
    const minDim = Math.min(vp.width, vp.height) * 0.5;
    let n = tree;
    for (;;) {
      let next = null;
      for (const k of n.children) {
        if (cx >= k.x && cx <= k.x + k.w && cy >= k.y && cy <= k.y + k.h) { next = k; break; }
      }
      if (!next || Math.min(next.w, next.h) * vp.scale < minDim) break;
      n = next;
      if (n.clip) break;
    }
    return n;
  }

  /** Deepest node containing the world point, or null. */
  pick(tree, wx, wy) {
    let found = null;
    (function walk(n) {
      if (wx < n.x || wy < n.y || wx > n.x + n.w || wy > n.y + n.h) return;
      found = n;
      for (const kid of n.children) walk(kid);
    })(tree);
    return found && found.depth >= 0 ? found : null;
  }
}

function emptyStats() {
  return {
    boxes: 0, cards: 0, labels: 0, culled: 0, collapsed: 0,
    linesDrawn: 0, linesTotal: 0, thumbs: 0, thumbPending: 0,
    textures: 0, texturesMade: 0, needsMore: false,
    ms: 0, level: "", zoomLabel: "", scale: 1,
  };
}

module.exports = { Renderer2D, THEME };
