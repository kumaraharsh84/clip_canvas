// ─── src/renderer/canvas/index.js ────────────────────────────────────────────
// Mounts the Time Canvas, owns the frame loop, and loads days as you reach them.
//
// The loop is DIRTY-DRIVEN: it draws only when something changed -- a pan, a
// zoom step, new data, a thumbnail landing, or card textures still waiting for
// frame budget. An idle canvas costs zero frames, which matters for a utility
// that sits on the desktop all day.
//
// DATA ARRIVES IN TWO SIZES, LIKE A MAP
//   counts  clips per day per category, for the whole history: one small query
//           (source.dayCounts). Enough to draw every day of every year.
//   days    full clips, only for days whose cell is big enough on screen to
//           show them (source.forDays), nearest the middle of the screen first,
//           one request at a time. Days far off screen are dropped again once
//           more than MAX_LOADED_CLIPS are held.
// A new copy refreshes the counts; only days whose signature changed (in
// practice: today) are reloaded, and nothing else on the canvas moves.
// ─────────────────────────────────────────────────────────────────────────────

const { Viewport } = require("./viewport");
const { Renderer2D } = require("./renderer2d");
const { Controls } = require("./controls");
const { ImageCache } = require("./imagecache");
const { TextureCache } = require("./texturecache");
const { fillDay, emptyDay, hourKey, timeParts, toDate } = require("./layout");
const Cal = require("./calendar");
const { describeNode } = require("./describe");
const { mountTimelineStrip } = require("./timelinestrip");
const { CATEGORY_LIST, CATEGORIES, categoryOf } = require("./classify");

const LOAD_MIN_PX = 26;          // a day cell at least this wide on screen loads its clips
const BATCH_MAX_DAYS = 60;       // days per forDays request
const BATCH_MAX_CLIPS = 4000;    // clips per forDays request (a bigger day still loads alone)
const MAX_LOADED_CLIPS = 40000;  // beyond this, off-screen days are dropped
const PUMP_DELAY_MS = 40;
const BASE_MAX_ZOOM = 8;

/**
 * @param {HTMLElement} host      container element (sized by CSS)
 * @param {object}      opts
 * @param {function}    opts.onSelect     (clipOrNull, node) => void
 * @param {function}    opts.onHover      (nodeOrNull) => void
 * @param {function}    opts.onFrame      (stats) => void
 * @param {function}    opts.resolveImage (clip, size) => URL of a picture at least
 *                                        `size` px wide, or URLs to try in order
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

  let root = Cal.buildCalendar(Cal.yearsFor([]));
  let source = null;
  let sourceGen = 0;      // bumps on every setSource; stale replies are dropped
  let countsReady = false;
  let dirty = true;
  let raf = null;
  let lastStats = null;
  const frameListeners = new Set();
  const dataListeners = new Set();

  // Loading state.
  const loaded = new Map();   // dayId -> { day, clips, seen, fit }
  let loadedClips = 0;
  let inflight = null;        // Promise of the request in flight
  let pumpTimer = null;
  let layoutGen = 0;
  let idleWaiters = [];
  let lastError = null;

  // ── Frame loop ─────────────────────────────────────────────────────────────
  function invalidate() {
    dirty = true;
    if (raf == null) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = null;
    if (!dirty) return;
    dirty = false;
    lastStats = renderer.draw(root, vp);
    lastStats.loadedDays = loaded.size;
    lastStats.loadedClips = loadedClips;
    if (opts.onFrame) opts.onFrame(lastStats);
    for (const fn of frameListeners) fn(lastStats);
    // Card textures are painted under a per-frame time budget; if some missed
    // it, come straight back for them. Settles as soon as all are painted.
    if (lastStats.needsMore) invalidate();
    schedulePump();
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  // The calendar is fixed, so a resize never re-lays anything out and never
  // moves the camera: resizing is not a request to go somewhere else.
  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    renderer.resize(w, h);
    vp.resize(w, h);
    invalidate();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ── Data ───────────────────────────────────────────────────────────────────
  /**
   * Point the canvas at a data source:
   *   { dayCounts: () => Promise<rows>, forDays: (days) => Promise<[{year, month, day, clips}]> }
   * Loaded days are dropped (the source is a different filter or workspace),
   * but the calendar is not rebuilt, so `view: "keep"` stays on the same date.
   * @param {"today"|"fit"|"keep"} [o.view]
   */
  async function setSource(src, { view = "keep" } = {}) {
    source = src;
    sourceGen++;
    countsReady = false;
    unloadAll();
    renderer.selectedKey = null;
    const ok = await refreshCounts();
    if (!ok) return false;
    if (view === "today") showToday(false);
    else if (view === "fit") fitAll(false);
    invalidate();
    return true;
  }

  /**
   * Re-read the counts. Call after anything that changes clips (a capture, an
   * edit, a delete). Only loaded days whose signature changed are reloaded.
   */
  async function refreshCounts() {
    if (!source) return false;
    const gen = sourceGen;
    let rows;
    try {
      rows = await source.dayCounts();
    } catch (err) {
      lastError = err;
      console.error("[timecanvas] dayCounts failed:", err);
      return false;
    }
    if (gen !== sourceGen) return false;

    const years = Cal.yearsFor(rows || []);
    if (years.join() !== root.years.join()) {
      // A new year at either end (or a first launch). Existing years keep
      // their places -- they are anchored to the year number -- so only the
      // loaded clips need re-attaching, which the pump does.
      unloadAll();
      root = Cal.buildCalendar(years);
    }
    Cal.applyCounts(root, rows || []);
    countsReady = true;

    // Stale or emptied days: reload if on screen (the pump does), else drop.
    const view = vp.worldBounds();
    for (const entry of Array.from(loaded.values())) {
      const d = entry.day;
      if (d.loadedSig === d.sig) continue;
      if (!d.count || !intersects(d, view)) unload(d);
    }

    markNow();
    for (const fn of dataListeners) fn(root);
    invalidate();
    schedulePump();
    return true;
  }

  function schedulePump() {
    if (pumpTimer != null || !source || !countsReady) return;
    pumpTimer = setTimeout(pump, PUMP_DELAY_MS);
  }

  /** Days on screen, big enough to show clips, that are not loaded or are stale. */
  function wantedDays() {
    const view = vp.worldBounds();
    const cx = (view.x0 + view.x1) / 2;
    const cy = (view.y0 + view.y1) / 2;
    const now = performance.now();
    const out = [];
    if (Cal.GEOMETRY.DAY_W * vp.scale < LOAD_MIN_PX) return out;
    for (const yr of root.children) {
      if (!intersects(yr, view)) continue;
      for (const mo of yr.children) {
        if (!intersects(mo, view)) continue;
        for (const d of mo.children) {
          if (!d.count || !intersects(d, view)) continue;
          const entry = loaded.get(d.dayId);
          if (entry) entry.seen = now;
          if (entry && d.loadedSig === d.sig) continue;
          const dx = d.x + d.w / 2 - cx;
          const dy = d.y + d.h / 2 - cy;
          out.push({ day: d, dist: dx * dx + dy * dy });
        }
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.map((o) => o.day);
  }

  async function pump() {
    pumpTimer = null;
    if (!source || !countsReady || inflight) return;

    const want = wantedDays();
    if (!want.length) {
      evict();
      settleIdle();
      return;
    }

    const batch = [];
    let clips = 0;
    for (const d of want) {
      if (batch.length && (batch.length >= BATCH_MAX_DAYS || clips + d.count > BATCH_MAX_CLIPS)) break;
      batch.push(d);
      clips += d.count;
    }
    await loadDays(batch);
    evict();
    schedulePump();
  }

  /**
   * Fetch and lay out these days. Requests run one at a time, in order.
   * Resolves (never rejects) once they are on the canvas.
   */
  function loadDays(days) {
    const gen = sourceGen;
    const req = days.map((d) => ({ year: d.time.year, month: d.time.month, day: d.time.day }));
    const run = async () => {
      if (gen !== sourceGen || !source) return;
      try {
        const res = await source.forDays(req);
        if (gen !== sourceGen) return;
        layoutGen++;
        for (const r of res || []) {
          const d = Cal.dayNode(root, r.year, r.month, r.day);
          if (d) attach(d, r.clips || []);
        }
      } catch (err) {
        lastError = err;
        console.error("[timecanvas] loading days failed:", err);
      }
      invalidate();
    };
    const p = (inflight || Promise.resolve()).then(run);
    const tracked = p.then(() => { if (inflight === tracked) inflight = null; });
    inflight = tracked;
    return p;
  }

  function attach(d, clips) {
    const prev = loaded.get(d.dayId);
    if (prev) loadedClips -= prev.clips;
    const fit = fillDay(d, clips);
    // Texture keys carry the layout generation: a reloaded day's cards may
    // have new shapes, and a texture painted for the old shape must not be reused.
    const tag = "#" + layoutGen;
    (function walk(n) {
      if (n.clip) { n.texKey = n.key + tag; return; }
      for (const k of n.children) walk(k);
    })(d);
    d.loaded = true;
    d.loadedSig = d.sig;
    loaded.set(d.dayId, { day: d, clips: clips.length, seen: performance.now(), fit });
    loadedClips += clips.length;
    raiseMaxZoom(fit.maxZoom);
  }

  function unload(d) {
    const entry = loaded.get(d.dayId);
    if (!entry) return;
    loaded.delete(d.dayId);
    loadedClips -= entry.clips;
    emptyDay(d);
    d.loaded = false;
    d.loadedSig = null;
    if (renderer.selectedKey && renderer.selectedKey.startsWith("c")) {
      // The selection may have been in this day; the card is gone either way.
      if (!findLeafByKey(root, renderer.selectedKey)) renderer.selectedKey = null;
    }
  }

  function unloadAll() {
    for (const entry of Array.from(loaded.values())) unload(entry.day);
    loadedClips = 0;
    vp.maxScale = Math.max(BASE_MAX_ZOOM, vp.scale);
  }

  /** Over budget: drop the days seen longest ago that are not on screen. */
  function evict() {
    if (loadedClips <= MAX_LOADED_CLIPS) return;
    const view = vp.worldBounds();
    const off = Array.from(loaded.values())
      .filter((e) => !intersects(e.day, view))
      .sort((a, b) => a.seen - b.seen);
    for (const e of off) {
      if (loadedClips <= MAX_LOADED_CLIPS * 0.8) break;
      unload(e.day);
    }
  }

  function raiseMaxZoom(z) {
    if (z > vp.maxScale) vp.maxScale = z;
  }

  function settleIdle() {
    if (inflight || pumpTimer != null) return;
    const w = idleWaiters;
    idleWaiters = [];
    for (const fn of w) fn();
  }

  /** Resolves once every day on screen that should be loaded is. For harnesses. */
  function whenIdle() {
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
      schedulePump();
      invalidate();
    });
  }

  // ── Now ────────────────────────────────────────────────────────────────────
  // The current hour and today stay marked. Checked every
  // minute, so the marker moves on when the hour does; a new day re-reads the
  // counts (yesterday is no longer "today", and the future is one day shorter).
  let todayId = null;
  function markNow() {
    const now = new Date();
    renderer.nowKey = hourKey(now);
    const d = Cal.dayOf(root, now);
    renderer.todayKey = d ? d.key : null;
    const id = d ? d.dayId : null;
    const changed = todayId !== null && id !== todayId;
    todayId = id;
    if (changed) Cal.markFuture(root, now);
    return changed;
  }
  const nowTimer = setInterval(() => {
    const prev = renderer.nowKey;
    if (markNow()) refreshCounts();
    else if (renderer.nowKey !== prev) invalidate();
  }, 60000);

  // ── Camera ─────────────────────────────────────────────────────────────────
  function fitAll(animate = true) {
    const target = contentBounds();
    if (animate) { controls.fit(target); return; }
    vp.fitTo({ x0: target.x, y0: target.y, x1: target.x + target.w, y1: target.y + target.h }, 24);
    invalidate();
  }

  /** The years that have clips (all of them when nothing does). */
  function contentBounds() {
    const withClips = root.children.filter((y) => y.count > 0);
    const ys = withClips.length ? withClips : root.children;
    const x0 = Math.min(...ys.map((y) => y.x));
    const x1 = Math.max(...ys.map((y) => y.x + y.w));
    return { x: x0, y: root.y, w: x1 - x0, h: root.h };
  }

  function showToday(animate = true) {
    const d = Cal.dayOf(root, new Date());
    if (!d) return fitAll(animate);
    if (animate) controls.flyTo(d);
    else { vp.fitTo({ x0: d.x, y0: d.y, x1: d.x + d.w, y1: d.y + d.h }, 24); invalidate(); }
  }

  /**
   * Fly to a clip, loading its day first if needed, and select it. `clip` is
   * any row with id and created_at (a search result, say).
   * @returns {Promise<object|null>} the clip's node
   */
  async function reveal(clip) {
    const t = timeParts(clip, toDate(clip.created_at));
    const d = Cal.dayNode(root, t.year, t.month, t.day);
    if (!d) return null;
    if (!d.loaded || d.loadedSig !== d.sig) await loadDays([d]);
    const leaf = findLeafByKey(d, "c" + clip.id);
    if (!leaf) { controls.flyTo(d); return null; }
    controls.flyTo(leaf);
    select(leaf);
    return leaf;
  }

  function select(node) {
    const clipNode = node && node.clip ? node : null;
    renderer.selectedKey = clipNode ? clipNode.key : null;
    invalidate();
    if (opts.onSelect) opts.onSelect(clipNode ? clipNode.clip : null, clipNode);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  const controls = new Controls(canvas, vp, {
    onChange: invalidate,
    getTree: () => root,
    pick: (t, wx, wy) => renderer.pick(t, wx, wy),
    onPick: (node) => select(node),
    onHover: (node) => {
      const key = node ? node.key : null;
      if (key !== renderer.hoverKey) {
        renderer.hoverKey = key;
        invalidate();
      }
      if (opts.onHover) opts.onHover(node);
    },
    onFit: () => fitAll(true),
    onToday: () => showToday(true),
  });

  markNow();
  resize();
  showToday(false);

  return {
    canvas, viewport: vp, renderer, controls, images, textures,
    categories: CATEGORY_LIST,
    categoryById: CATEGORIES,
    setSource,
    /** Show an in-memory list of clips (the demo, the harnesses). */
    setClips: (clips, o) => setSource(memorySource(clips), o),
    refresh: refreshCounts,
    reveal,
    select,
    invalidate,
    fitAll,
    showToday,
    whenIdle,
    flyTo: (node) => controls.flyTo(node),
    flyOut: () => controls.flyOut(),
    getTree: () => root,
    dayNode: (y, m, d) => Cal.dayNode(root, y, m, d),
    /** The box that currently frames the view -- "where am I". */
    framed: () => renderer.framedNode(root, vp),
    describe: describeNode,
    /** Subscribe to every drawn frame. Returns an unsubscribe function. */
    onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); },
    /** Subscribe to data changes (new counts). Returns an unsubscribe function. */
    onData(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); },
    stats: () => ({
      frame: lastStats,
      loaded: loadedSummary(),
      images: images.stats(), textures: textures.stats(),
      error: lastError ? String(lastError.message || lastError) : null,
    }),
    destroy() {
      ro.disconnect();
      clearInterval(nowTimer);
      clearTimeout(pumpTimer);
      controls.destroy();
      images.clear();
      textures.clear();
      if (raf != null) cancelAnimationFrame(raf);
      frameListeners.clear();
      dataListeners.clear();
      canvas.remove();
    },
  };

  /** What is loaded, and how well its text fits, over the loaded days. */
  function loadedSummary() {
    let minFontScale = 1, worstOverflow = 0, failed = 0, clips = 0;
    for (const e of loaded.values()) {
      clips += e.clips;
      failed += e.fit.failed;
      if (e.fit.minFontScale < minFontScale) minFontScale = e.fit.minFontScale;
      if (e.fit.worstOverflow > worstOverflow) worstOverflow = e.fit.worstOverflow;
    }
    return { days: loaded.size, clips, minFontScale, worstOverflow, failed, maxZoom: vp.maxScale };
  }
}

function intersects(n, v) {
  return !(n.x > v.x1 || n.y > v.y1 || n.x + n.w < v.x0 || n.y + n.h < v.y0);
}

function findLeafByKey(n, key) {
  if (n.key === key) return n;
  for (const k of n.children) {
    const hit = findLeafByKey(k, key);
    if (hit) return hit;
  }
  return null;
}

/**
 * A data source over an array of clip rows, answering the same two questions
 * the app asks the database. For the demo and the headless checks.
 */
function memorySource(clips) {
  const byDay = new Map();
  for (const clip of clips || []) {
    const t = timeParts(clip, toDate(clip.created_at));
    const id = Cal.dayId(t.year, t.month, t.day);
    let list = byDay.get(id);
    if (!list) byDay.set(id, (list = []));
    list.push(clip);
  }
  const secs = (c) => Math.floor(toDate(c.created_at).getTime() / 1000);
  for (const list of byDay.values()) list.sort((a, b) => secs(a) - secs(b) || a.id - b.id);

  return {
    async dayCounts() {
      const rows = [];
      for (const list of byDay.values()) {
        const t = timeParts(list[0], toDate(list[0].created_at));
        const per = new Map();
        for (const c of list) {
          const cat = c.category || categoryOf(c).id;
          let r = per.get(cat);
          if (!r) per.set(cat, (r = { year: t.year, month: t.month, day: t.day, category: cat, n: 0, t0: Infinity, t1: 0, v: 0, dv: 0 }));
          r.n++;
          r.t0 = Math.min(r.t0, secs(c));
          r.t1 = Math.max(r.t1, secs(c));
        }
        rows.push(...per.values());
      }
      return rows;
    },
    async forDays(days) {
      return days.map((d) => ({ ...d, clips: byDay.get(Cal.dayId(d.year, d.month, d.day)) || [] }));
    },
  };
}

module.exports = { mountTimeCanvas, mountTimelineStrip, describeNode, memorySource };
