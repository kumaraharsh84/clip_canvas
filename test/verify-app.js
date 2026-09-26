// ─── test/verify-app.js ───────────────────────────────────────────────────
// End-to-end check of the app: db.js -> IPC -> preload.js -> index.html ->
// renderer.js -> the Time Canvas, driven headlessly: it opens on today, a
// whole year loads its days, a new copy moves nothing outside today, search
// reveals a clip in a day that was not loaded, and hours and clips render.
//
// Same pattern as v1's test/archive/v1/benchmark-renderer.js: a thin IPC layer stands in for
// main.js so the tray, hotkey and clipboard watcher never start, and the REAL
// renderer is loaded and inspected. The clip-asset:// handler is the app's own
// (src/main/assetProtocol.js), not a copy, so image loading is really tested.
//
// Usage:
//   npx electron test/verify-app.js [--db=PATH] [--shots=DIR] [--keep-open]
//
// --shots=DIR writes today.png, overview.png, month.png, hour.png and clip.png. The window renders
// OFFSCREEN: a hidden normal window stops producing compositor frames, and
// capturePage then returns a stale one -- an earlier version of this harness
// photographed the start-up view no matter where the camera had flown.
//
// SAFETY: runs against a COPY of the database. It never writes to
// %APPDATA%/clipcanvas/clipcanvas.db.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { ClipDatabase } = require("../src/main/db");
const { registerAssetScheme, handleAssetProtocol } = require("../src/main/assetProtocol");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const KEEP_OPEN = argv.includes("--keep-open");
const SHOTS = flag("shots", null);
// --no-osr renders in a normal hidden window (GPU canvas) to compare timings.
// Screenshots need OSR; see the note in the header.
const OSR = !KEEP_OPEN && !argv.includes("--no-osr");

app.name = "clipcanvas";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

registerAssetScheme(protocol);

const LIVE_DB = path.join(app.getPath("appData"), "clipcanvas", "clipcanvas.db");
const LIVE_STORE = path.join(app.getPath("appData"), "clipcanvas", "storage");
const SRC_DB = flag("db", LIVE_DB);

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};
const info = (s) => console.log("       " + s);

function copyDb() {
  const tmp = path.join(os.tmpdir(), "clipcanvas-verify-" + Date.now() + ".db");
  fs.copyFileSync(SRC_DB, tmp);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(SRC_DB + suffix)) fs.copyFileSync(SRC_DB + suffix, tmp + suffix);
  }
  return tmp;
}

function registerIpc(db, workspaceId) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try { return { success: true, data: await fn(...args) }; }
      catch (err) {
        console.error(`[verify] IPC "${channel}":`, err.message);
        return { success: false, error: err.message };
      }
    });
  };
  const ws = (o = {}) => ({ ...o, workspaceId: o.workspaceId || workspaceId });

  handle("workspaces:list", () => {
    const all = db.listWorkspaces();
    return all.filter((w) => w.id === workspaceId).concat(all.filter((w) => w.id !== workspaceId));
  });
  handle("workspaces:setActive", () => ({ ok: true, activeWorkspaceId: workspaceId }));
  handle("workspaces:create", (name) => db.createWorkspace(name));
  handle("boards:list", (id) => db.listBoards(id || workspaceId));
  handle("boards:setActive", () => ({ ok: true }));

  handle("clips:getAll", (o = {}) => db.getClips(ws(o)));
  handle("clips:getPage", (o = {}) => db.getClipPage(ws(o)));
  handle("clips:getSummaries", (o = {}) => db.getClipSummaries(ws(o)));
  handle("clips:getById", (id) => db.getClipById(id));
  handle("clips:getContent", (id) => db.getClipContent(id));
  handle("clips:search", (o = {}) => db.searchClips(ws(o)));
  handle("clips:update", ({ id, patch }) => db.updateClip(id, patch));
  handle("clips:delete", (ids) => db.deleteClips([].concat(ids)));
  handle("clips:restore", (ids) => db.restoreClips([].concat(ids)));
  handle("clips:archive", (ids) => db.archiveClips([].concat(ids)));
  handle("clips:copyBack", (id) => ({ ok: true, id }));
  handle("clips:trashSummary", (o = {}) => db.getTrashSummary(ws(o)));
  handle("clips:emptyTrash", (o = {}) => db.getTrashSummary(ws(o))); // read-only here
  handle("clips:dayCounts", (o = {}) => db.getDayCounts(ws(o)));
  handle("clips:forDays", (o = {}) => db.getClipsForDays(ws(o)));
  handle("capture:getState", () => ({ paused: false }));
  handle("capture:setPaused", (p) => ({ paused: !!p }));
  handle("storage:getStats", (o = {}) => db.getStorageStats(ws(o)));
  handle("storage:openFolder", () => ({ ok: true }));
  handle("settings:getMaxFileSize", () => 0);
  handle("window:hide", () => null);
  handle("window:minimize", () => null);

  handle("time:getYears", (id) => db.getYears(id || workspaceId));
  handle("time:getMonths", ({ year } = {}) => db.getMonths(year, workspaceId));
  handle("time:getDays", ({ year, month } = {}) => db.getDays(year, month, workspaceId));
  handle("time:getHours", ({ year, month, day } = {}) => db.getHours(year, month, day, workspaceId));
  handle("time:getClipsInTimeRange", ({ startTimestamp, endTimestamp } = {}) =>
    db.getClipsInTimeRange(startTimestamp, endTimestamp, workspaceId));
  handle("time:getSessions", ({ startTimestamp, endTimestamp, gapMinutes } = {}) =>
    db.getSessions(startTimestamp, endTimestamp, workspaceId, gapMinutes));
  handle("time:backfill", () => ({ updated: 0 }));
}

// ── Probes (run inside the real renderer) ────────────────────────────────────
const WAIT_MOUNT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let w = 0; w < 25000; w += 100) {
    const tc = window.__tc;
    if (tc && tc.getTree().count > 0 && document.querySelector("canvas.time-canvas-2d")) break;
    await sleep(100);
  }
  const tc = window.__tc;
  if (!tc || !tc.getTree().count) return { error: "Time Canvas never got its counts" };
  await tc.whenIdle();
  await sleep(600);
  return { ok: true };
})()`;

// The app opens on today: today's cell fills the view.
const TODAY = `(() => {
  const tc = window.__tc, vp = tc.viewport, now = new Date();
  const d = tc.dayNode(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const v = vp.worldBounds();
  const cover = Math.min(d.w * vp.scale / vp.width, d.h * vp.scale / vp.height);
  const inView = d.x >= v.x0 - 1 && d.x + d.w <= v.x1 + 1 && d.y >= v.y0 - 1 && d.y + d.h <= v.y1 + 1;
  return { label: d.labelLong, count: d.count, loaded: d.loaded, cover, inView,
           marked: tc.renderer.todayKey === d.key };
})()`;

// Fit everything with clips: a year view, whose days load their clips.
const OVERVIEW = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  tc.fitAll(false);
  await tc.whenIdle();
  await sleep(1500); // let textures paint in over their per-frame budget
  tc.invalidate();
  await sleep(200);
  const canvas = document.querySelector("canvas.time-canvas-2d");
  const st = tc.stats();
  let painted = null, tainted = false;
  try {
    const ctx = canvas.getContext("2d");
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let non = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] !== 11 || d[i+1] !== 15 || d[i+2] !== 20) non++; }
    painted = non / n;
  } catch (e) { tainted = true; }
  const root = tc.getTree();
  let daysWithClips = 0;
  for (const d of root.dayIndex.values()) if (d.count) daysWithClips++;
  return {
    canvas: [canvas.width, canvas.height],
    status: document.getElementById("status").textContent,
    hud: document.getElementById("hud").textContent,
    workspaces: Array.from(document.getElementById("workspace").options).map((o) => o.textContent),
    legend: document.querySelectorAll("#legend .chip").length,
    timeline: !!document.querySelector("#timeline canvas.timeline-strip"),
    info: document.getElementById("info-title").textContent,
    domNodes: document.getElementsByTagName("*").length,
    emptyShown: !document.getElementById("empty").hidden,
    painted, tainted,
    total: root.count, daysWithClips, years: root.years,
    loaded: st.loaded, error: st.error,
    frame: st.frame,
    texturesMade: st.textures.made,
  };
})()`;

// Where every day cell and every loaded card is, by key.
const SNAPSHOT = `(() => {
  const tc = window.__tc, out = { days: {}, cards: {} };
  const r = (n) => [n.x, n.y, n.w, n.h].map((v) => Math.round(v * 1000) / 1000).join(",");
  for (const d of tc.getTree().dayIndex.values()) {
    out.days[d.dayId] = r(d);
    (function walk(n) { if (n.clip) { out.cards[n.key] = { r: r(n), day: d.dayId }; return; } n.children.forEach(walk); })(d);
  }
  return out;
})()`;

const WAIT_COUNT = (n) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  for (let w = 0; w < 8000 && tc.getTree().count < ${n}; w += 100) await sleep(100);
  await tc.whenIdle();
  await sleep(300);
  return tc.getTree().count;
})()`;

const REVEAL = (clip) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  const clip = ${JSON.stringify(clip)};
  const leaf = await tc.reveal(clip);
  await sleep(800);
  await tc.whenIdle();
  const d = leaf && leaf.parent && leaf.parent.parent;
  const v = tc.viewport.worldBounds();
  const onScreen = leaf && leaf.x < v.x1 && leaf.x + leaf.w > v.x0 && leaf.y < v.y1 && leaf.y + leaf.h > v.y0;
  const inDay = leaf && d && leaf.x >= d.x && leaf.y >= d.y && leaf.x + leaf.w <= d.x + d.w + 1e-6 && leaf.y + leaf.h <= d.y + d.h + 1e-6;
  return { found: !!leaf, selected: tc.renderer.selectedKey, onScreen: !!onScreen, inDay: !!inDay,
           details: !document.getElementById("details").hidden,
           day: d ? d.dayId : null, zoom: tc.viewport.scale };
})()`;

// Frame one month: the wall-calendar view.
const MONTH = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  let best = null;
  for (const y of tc.getTree().children) for (const m of y.children) if (!best || m.count > best.count) best = m;
  tc.viewport.fitTo({ x0: best.x, y0: best.y, x1: best.x + best.w, y1: best.y + best.h }, 12);
  tc.invalidate();
  await tc.whenIdle();
  await sleep(1200);
  return { label: best.labelLong, count: best.count, frame: tc.stats().frame };
})()`;

// Frame the busiest hour that has images in it, and wait for thumbnails.
const HOUR = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  let best = null, bs = -1;
  (function walk(n) {
    if (n.depth === 3) {
      const imgs = n.children.filter((c) => c.clip.type === "image").length;
      const kinds = new Set(n.children.map((c) => c.cat.id)).size;
      const score = (imgs ? 10 : 0) + kinds * 2 + Math.min(12, n.children.length);
      if (score > bs) { bs = score; best = n; }
      return;
    }
    n.children.forEach(walk);
  })(tc.getTree());
  tc.viewport.fitTo({ x0: best.x, y0: best.y, x1: best.x + best.w, y1: best.y + best.h }, 12);
  tc.invalidate();
  for (let w = 0; w < 6000; w += 200) {
    await sleep(200);
    const s = tc.images.stats();
    if (s.pending === 0 && s.queued === 0 && (s.entries > 0 || s.failed > 0)) break;
  }
  // Wait for a frame that has drawn them. Decoding finishing is not the same
  // as a frame having landed -- hidden windows throttle animation frames.
  for (let w = 0; w < 4000; w += 100) {
    const f = tc.stats().frame;
    if (f && f.thumbs > 0 && f.thumbPending === 0) break;
    tc.invalidate();
    await sleep(100);
  }
  const images = best.children.filter((c) => c.clip.type === "image").length;
  return { label: best.labelLong, clips: best.children.length, images,
           imageCache: tc.images.stats(), frame: tc.stats().frame };
})()`;

// Warm-frame cost at the current view: draw N times directly, count calls.
const PERF = `(() => {
  const tc = window.__tc;
  const r = tc.renderer, tree = tc.getTree(), vp = tc.viewport;
  const ctx = r.ctx;
  const counts = { fillText: 0, fillRect: 0, fill: 0, drawImage: 0, font: 0 };
  const orig = {};
  for (const k of ["fillText", "fillRect", "fill", "drawImage"]) {
    orig[k] = ctx[k];
    ctx[k] = function () { counts[k]++; return orig[k].apply(this, arguments); };
  }
  const times = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    r.draw(tree, vp);
    // No pixel readback here: repeated getImageData makes Chromium log a
    // willReadFrequently advisory, which this harness would count as a console
    // error of its own making. Under OSR the canvas rasterises in software, so
    // these timings include raster; under --no-osr they are recording cost.
    times.push(performance.now() - t0);
  }
  for (const k in orig) ctx[k] = orig[k];
  times.sort((a, b) => a - b);
  const per = (k) => Math.round(counts[k] / 12);
  return {
    first: times[times.length - 1].toFixed(1), median: times[6].toFixed(1), best: times[0].toFixed(1),
    perFrame: { fillText: per("fillText"), fillRect: per("fillRect"), fill: per("fill"), drawImage: per("drawImage") },
    lines: r.stats.linesDrawn, cards: r.stats.cards,
  };
})()`;

// Frame one medium text clip so its body is real glyphs.
const CLIP = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tc = window.__tc;
  let target = null;
  (function walk(n) {
    if (target) return;
    if (n.clip) {
      const len = (n.clip.content || "").length;
      if (n.clip.type === "code" && len > 600 && len < 4000) target = n;
      return;
    }
    n.children.forEach(walk);
  })(tc.getTree());
  if (!target) return { error: "no medium code clip" };
  tc.viewport.fitTo({ x0: target.x, y0: target.y, x1: target.x + target.w, y1: target.y + target.h }, 16);
  tc.invalidate();
  await sleep(900);
  const d = tc.describe(target);
  return { category: d.category, time: d.time, chars: d.chars, lines: d.lines, frame: tc.stats().frame };
})()`;

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC_DB)) {
    console.error("[verify] no database at", SRC_DB);
    app.exit(1);
    return;
  }

  const dbPath = copyDb();
  console.log("[verify] copied database ->", path.basename(dbPath));
  const db = new ClipDatabase(dbPath, LIVE_STORE);
  handleAssetProtocol(protocol, LIVE_STORE);

  const all = db.listWorkspaces();
  const target = all.find((w) => w.clip_count > 0) || all[0];
  console.log(`[verify] workspace "${target.name}" with ${target.clip_count} clips\n`);
  registerIpc(db, target.id);

  const win = new BrowserWindow({
    width: 1400, height: 860, show: KEEP_OPEN,
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,   // as in main.js
      offscreen: OSR,
      backgroundThrottling: false,
    },
  });

  const errors = [];
  // Warnings and errors. Electron 35+ puts level ("warning"/"error") and
  // message on the event; older versions passed them as arguments (2 / 3).
  win.webContents.on("console-message", (e, ...old) => {
    const level = e.level !== undefined ? e.level : old[0];
    const message = e.message !== undefined ? e.message : old[1];
    if (level === "warning" || level === "error" || level >= 2) errors.push(message);
  });
  win.webContents.on("preload-error", (_e, p, err) => errors.push("preload: " + err.message));

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  const run = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage();
    const file = path.join(SHOTS, name + ".png");
    fs.writeFileSync(file, img.toPNG());
    info("wrote " + file);
  };

  try {
    const m = await run(WAIT_MOUNT);
    if (m.error) throw new Error(m.error);

    // ── 1. Opens on today ─────────────────────────────────────────────────
    const td = await run(TODAY);
    console.log("-- opens on today: " + td.label + " --");
    ok("today's cell fills the view", td.inView && td.cover > 0.6, `covers ${(td.cover * 100).toFixed(0)}% of the view`);
    ok("today is marked", td.marked);
    if (td.count) ok("today's clips are loaded", td.loaded, `${td.count} clips`);
    await shot("today");

    // ── 2. The whole archive: a year of calendar, days loaded ─────────────
    const o = await run(OVERVIEW);
    console.log("\n-- overview: " + o.years.join(", ") + " --");
    ok("clips counted from the real database", /\d+ clips/.test(o.status), o.status.trim());
    ok("empty state not shown", !o.emptyShown);
    ok("no loading errors", !o.error, o.error || "");
    ok("canvas painted", o.tainted || o.painted > 0.2,
       o.tainted ? "(canvas tainted -- see image check)" : (100 * o.painted).toFixed(1) + "% of pixels");
    ok("days on screen load their clips", o.loaded.days > 0,
       `${o.loaded.days} of ${o.daysWithClips} days with clips loaded · ${o.loaded.clips} of ${o.total} clips`);
    ok("every loaded card's full text fits", o.loaded.failed === 0 && o.loaded.worstOverflow <= 1.0001,
       `worst ${o.loaded.worstOverflow.toFixed(3)}, ${o.loaded.failed} failed`);
    ok("smallest text is reachable by zooming", 12 * o.loaded.minFontScale * o.loaded.maxZoom >= 6.99,
       `text ${(o.loaded.minFontScale * 100).toFixed(1)}% -> max zoom ${o.loaded.maxZoom.toFixed(1)}x`);
    ok("cards are drawn", o.frame.cards > 0, `${o.frame.cards} cards, ${o.texturesMade} textures painted`);
    ok("legend lists categories", o.legend > 0, `${o.legend} categories`);
    ok("timeline strip mounted", o.timeline);
    ok("info panel populated", !!o.info.trim(), JSON.stringify(o.info.trim()));
    ok("workspaces populated", o.workspaces.length > 0, o.workspaces.join(" | "));
    ok("DOM stays small (canvas, not DOM nodes)", o.domNodes < 260, o.domNodes + " nodes");
    info(o.hud);
    await shot("overview");

    // ── 3. A new copy moves nothing outside today ─────────────────────────
    const before = await run(SNAPSHOT);
    const now = new Date();
    const todayId = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    const added = db.addClip({
      type: "text", content: "verify-app: a new copy, " + now.toISOString(),
      workspace_id: target.id, source: "clipboard", storage_mode: "inline",
    });
    win.webContents.send("clip:added", added);
    const count = await run(WAIT_COUNT(o.total + 1));
    const after = await run(SNAPSHOT);
    let daysMoved = 0, cardsMoved = 0, cardsKept = 0;
    for (const id in before.days) if (after.days[id] !== before.days[id]) daysMoved++;
    for (const k in before.cards) {
      const b = before.cards[k];
      if (b.day === todayId) continue;
      cardsKept++;
      if (!after.cards[k] || after.cards[k].r !== b.r) cardsMoved++;
    }
    console.log("\n-- a new copy --");
    ok("the new clip is counted", count === o.total + 1, `${o.total} -> ${count}`);
    ok("no day cell moved", daysMoved === 0, `${daysMoved} of ${Object.keys(before.days).length} moved`);
    ok("no card outside today moved", cardsMoved === 0, `${cardsMoved} of ${cardsKept} moved`);
    const nv = await run(REVEAL(added));
    ok("the new clip is on today's cell", nv.found && nv.day === todayId && nv.inDay, JSON.stringify(nv));
    await run(`window.__tc.select(null)`);

    // ── 4. Search reveals a clip whose day was not loaded ─────────────────
    await run(`(async () => { window.__tc.fitAll(false); await window.__tc.whenIdle(); })()`);
    const far = db.db.prepare(
      "SELECT * FROM clips WHERE workspace_id = ? AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at ASC LIMIT 1"
    ).get(target.id);
    const rv = await run(REVEAL(far));
    console.log("\n-- search reveal: clip #" + far.id + " --");
    ok("clip found and selected", rv.found && rv.selected === "c" + far.id, JSON.stringify(rv));
    ok("camera flew to it", rv.onScreen && rv.inDay);
    ok("details panel open", rv.details);
    await run(`window.__tc.select(null)`);

    // ── 5. A month, like a wall calendar ──────────────────────────────────
    const mo = await run(MONTH);
    console.log("\n-- month: " + mo.label + " --");
    ok("month view draws its days", mo.frame.days >= 28, `${mo.frame.days} day cells, ${mo.frame.cards} cards`);
    await shot("month");

    // ── 6. One hour, with its images ──────────────────────────────────────
    const h = await run(HOUR);
    console.log("\n-- hour: " + h.label + " --");
    info(`${h.clips} clips, ${h.images} images · cache ${JSON.stringify(h.imageCache)}`);
    if (h.images > 0) {
      ok("image thumbnails decode", h.imageCache.entries > 0 && h.imageCache.failed === 0,
         `${h.imageCache.entries} decoded, ${h.imageCache.failed} failed`);
      ok("thumbnails drawn on cards", h.frame.thumbs > 0, `${h.frame.thumbs} drawn`);
    }
    info(`level ${h.frame.level} · ${h.frame.cards} cards · lines ${h.frame.linesDrawn}/${h.frame.linesTotal}`);
    await shot("hour");

    // ── 7. One clip, readable ─────────────────────────────────────────────
    const c = await run(CLIP);
    console.log("\n-- clip --");
    if (c.error) {
      info(c.error);
    } else {
      info(`${c.category} copied at ${c.time} · ${c.chars} chars · ${c.lines} lines`);
      ok("text drawn as real lines at clip zoom", c.frame.linesDrawn > 0,
         `${c.frame.linesDrawn} lines drawn, ${c.frame.ms.toFixed(1)} ms`);
    }
    if (argv.includes("--perf")) {
      const pf = await run(PERF);
      info(`warm frames: median ${pf.median} ms, best ${pf.best}, worst ${pf.first} ` +
           `· ${pf.cards} cards, ${pf.lines} lines`);
      info(`per frame: ${JSON.stringify(pf.perFrame)}`);
    }
    await shot("clip");
  } catch (err) {
    ok("probe", false, err.message);
  }

  // The watcher needs Electron's synchronous clipboard API, which Electron 44
  // replaced. This is the check that fails if an upgrade takes it away.
  console.log("\n-- this Electron's clipboard --");
  {
    const { clipboard } = require("electron");
    const { ClipboardWatcher } = require("../src/main/clipwatch");
    let err = null;
    try { new ClipboardWatcher({ clipboard, onText() {}, onImage() {}, sequence: null }); } catch (e) { err = e; }
    ok("the clipboard watcher can run on Electron " + process.versions.electron, !err, err ? err.message : "");
    ok("readText answers synchronously", typeof clipboard.readText() === "string");
  }

  console.log("\n-- renderer console --");
  ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  db.close();
  try { fs.unlinkSync(dbPath); } catch (_) {}

  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAPP VERIFIED END TO END\n");
  if (!KEEP_OPEN) app.exit(failures ? 1 : 0);
});
