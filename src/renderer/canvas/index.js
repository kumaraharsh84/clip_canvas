// ─── src/renderer/canvas/index.js ────────────────────────────────────────────
// Mounts the Time Canvas and owns the frame loop.
//
// The loop is DIRTY-DRIVEN: it draws only when something changed -- a pan, a
// zoom step, new data, a thumbnail landing, or card textures still waiting for
// frame budget. An idle canvas costs zero frames, which matters for a utility
// that sits on the desktop all day.
// ─────────────────────────────────────────────────────────────────────────────

const { Viewport } = require("./viewport");
const { Renderer2D } = require("./renderer2d");
const { Controls } = require("./controls");
const { ImageCache } = require("./imagecache");
const { TextureCache } = require("./texturecache");
const { buildTree, layoutAuto, hourKey } = require("./layout");
const { clearCaches, cacheStats } = require("./textlayout");
const { clearTokenCache } = require("./tokens");
const { describeNode } = require("./describe");
const { mountTimelineStrip } = require("./timelinestrip");
const { CATEGORY_LIST, CATEGORIES } = require("./classify");

/**
 * @param {HTMLElement} host      container element (sized by CSS)
 * @param {object}      opts
 * @param {function}    opts.onSelect     (clipOrNull, node) => void
 * @param {function}    opts.onHover      (nodeOrNull) => void
 * @param {function}    opts.onFrame      (stats) => void
 * @param {function}    opts.resolveImage (clip) => url for a thumbnail
 */
function mountTimeCanvas(host, opts = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "time-canvas-2d";
  canvas.style.display = "block";
  canvas.style.cursor = "grab";
  host.appendChild(canvas);

  const vp = new Viewport();
  const images = new ImageCache({ resolve: opts.resolveImage, onReady: () => invalidate() });
  const textures = new TextureCache();
  const renderer = new Renderer2D(canvas, { imageCache: images, textureCache: textures });

  let tree = null;
  let layoutInfo = null;
  let dirty = true;
  let raf = null;
  let lastStats = null;
  const frameListeners = new Set();
  const dataListeners = new Set();

  // ── Frame loop ─────────────────────────────────────────────────────────────
  function invalidate() {
    dirty = true;
    if (raf == null) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = null;
    if (!dirty || !tree) return;
    dirty = false;
    lastStats = renderer.draw(tree, vp);
    if (opts.onFrame) opts.onFrame(lastStats);
    for (const fn of frameListeners) fn(lastStats);
    // Card textures are painted under a per-frame time budget; if some missed
    // it, come straight back for them. Settles as soon as all are painted.
    if (lastStats.needsMore) invalidate();
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  // The canvas aspect is baked in at layout time. A large aspect change (a
  // narrow pane at first paint, a window dragged much wider) re-lays out --
  // debounced, and never moving the camera: resizing is not a request to go
  // somewhere else.
  const RELAYOUT_ASPECT_FACTOR = 1.3;
  let lastAspect = 0;
  let lastClips = null;
  let relayoutTimer = null;

  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    renderer.resize(w, h);
    vp.resize(w, h);

    const aspect = w / h;
    if (tree && lastAspect > 0) {
      const drift = aspect > lastAspect ? aspect / lastAspect : lastAspect / aspect;
      if (drift > RELAYOUT_ASPECT_FACTOR) {
        clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(() => { if (lastClips) setClips(lastClips, { keepView: true }); }, 250);
      }
    }
    invalidate();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ── Data ───────────────────────────────────────────────────────────────────
  function setClips(clips, { keepView = false } = {}) {
    const snap = vp.snapshot();
    lastClips = clips || [];
    tree = buildTree(lastClips);

    const aspect = vp.width && vp.height ? vp.width / vp.height : 1.6;
    lastAspect = aspect;
    layoutInfo = layoutAuto(tree, { aspect });
    vp.maxScale = layoutInfo.maxZoom;

    // Geometry changed, so painted textures and wrapped lines are stale.
    textures.clear();
    clearTokenCache();
    clearCaches();

    renderer.nowKey = hourKey(new Date());
    renderer.hoverKey = null;

    if (keepView) vp.restore(snap);
    else fitAll(false);

    for (const fn of dataListeners) fn(tree);
    invalidate();
    return layoutInfo;
  }

  function fitAll(animate = true) {
    if (!tree) return;
    if (animate) { controls.fit(tree); return; }
    vp.fitTo({ x0: tree.x, y0: tree.y, x1: tree.x + tree.w, y1: tree.y + tree.h }, 24);
    invalidate();
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  const controls = new Controls(canvas, vp, {
    onChange: invalidate,
    getTree: () => tree,
    pick: (t, wx, wy) => renderer.pick(t, wx, wy),
    onPick: (node) => {
      const clipNode = node && node.clip ? node : null;
      renderer.selectedKey = clipNode ? clipNode.key : null;
      invalidate();
      if (opts.onSelect) opts.onSelect(clipNode ? clipNode.clip : null, clipNode);
    },
    onHover: (node) => {
      const key = node ? node.key : null;
      if (key !== renderer.hoverKey) {
        renderer.hoverKey = key;
        invalidate();
      }
      if (opts.onHover) opts.onHover(node);
    },
  });

  resize();
  if (opts.clips) setClips(opts.clips);

  return {
    canvas, viewport: vp, renderer, controls, images, textures,
    categories: CATEGORY_LIST,
    categoryById: CATEGORIES,
    setClips,
    invalidate,
    fitAll,
    flyTo: (node) => controls.flyTo(node),
    flyOut: () => controls.flyOut(),
    getTree: () => tree,
    getLayout: () => layoutInfo,
    /** The box that currently frames the view -- "where am I". */
    framed: () => (tree ? renderer.framedNode(tree, vp) : null),
    describe: describeNode,
    /** Subscribe to every drawn frame. Returns an unsubscribe function. */
    onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); },
    /** Subscribe to data changes (setClips). Returns an unsubscribe function. */
    onData(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); },
    stats: () => ({
      frame: lastStats, layout: layoutInfo,
      text: cacheStats(), images: images.stats(), textures: textures.stats(),
    }),
    destroy() {
      ro.disconnect();
      controls.destroy();
      images.clear();
      textures.clear();
      clearTokenCache();
      clearCaches();
      if (raf != null) cancelAnimationFrame(raf);
      frameListeners.clear();
      dataListeners.clear();
      canvas.remove();
    },
  };
}

module.exports = { mountTimeCanvas, mountTimelineStrip, describeNode };
