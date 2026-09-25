// ─── src/renderer/canvas/lod.js ──────────────────────────────────────────────
// Level-of-detail vocabulary for the Time Canvas.
//
// The zoom labels reproduce the roadmap ladder that scratch/verify-time-zoom.js
// asserts:  500% years | 400% months | 300% days | 200% hours | 100% clips
//
// The level is no longer derived from an absolute scale. The canvas is now
// sized from its contents, so "scale 0.2" means something different for 600
// clips than for 20,000. Instead the renderer finds which box currently frames
// the view (renderer2d.framedNode) and the level is what you see INSIDE it:
// framing a month means you are looking at days.
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL = {
  YEARS:  { id: "years",  label: "500%", rank: 4 },
  MONTHS: { id: "months", label: "400%", rank: 3 },
  DAYS:   { id: "days",   label: "300%", rank: 2 },
  HOURS:  { id: "hours",  label: "200%", rank: 1 },
  CLIPS:  { id: "clips",  label: "100%", rank: 0 },
};

const BY_DEPTH = [LEVEL.YEARS, LEVEL.MONTHS, LEVEL.DAYS, LEVEL.HOURS, LEVEL.CLIPS];

/** Level shown when a node of `depth` is framed + 1, i.e. what you see in it. */
function levelForDepth(depth) {
  if (depth <= 0) return LEVEL.YEARS;
  return BY_DEPTH[Math.min(BY_DEPTH.length - 1, depth)];
}

/** Thumbnails are worth decoding once they cover a few pixels. */
function wantsThumbnail(rect, scale) {
  return rect.w * scale >= 10 && rect.h * scale >= 10;
}

/**
 * Decode size for a thumbnail, quantised to powers of two so panning and small
 * zoom nudges reuse the same cached bitmap instead of thrashing the decoder.
 */
function thumbBudget(rect, scale) {
  const want = Math.max(rect.w, rect.h) * scale;
  const p2 = Math.pow(2, Math.ceil(Math.log2(Math.max(32, want))));
  return Math.min(1024, p2);
}

module.exports = { LEVEL, levelForDepth, wantsThumbnail, thumbBudget };
