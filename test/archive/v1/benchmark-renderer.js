// ─── scratch/benchmark-renderer.js ───────────────────────────────────────────
// Repeatable renderer benchmark for ClipCanvas.
//
// Produces the same shape as benchmark_results.json so old and new runs are
// directly comparable. Drives the REAL renderer (index.html + renderer.js +
// preload.js) against the REAL database, with a thin IPC layer standing in for
// main.js so the tray / edge tab / clipboard watcher never start.
//
// Usage (PowerShell):
//   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
//   npx electron scratch/benchmark-renderer.js
//
// Flags:
//   --workspace=NAME       workspace to measure          (default: PERF_TEST)
//   --target=N             max clips to load into the UI (default: 10000)
//   --width=N --height=N   viewport                      (default: 760x640)
//   --scroll-ms=N          scroll sampling duration      (default: 2000)
//   --query=TERM           search term                   (default: perf)
//   --out=PATH             results file                  (default: benchmark_results.json)
//   --backfill-time        backfill NULL year/month/day/hour rows before measuring
//   --keep-open            leave the window open after the run
//   --profile              attribute load time across hot renderer functions
//   --count-ops            count forced-layout reads and listener bindings
//
// SAFETY: read-only against your clips. The only write it can perform is the
// opt-in --backfill-time UPDATE, which fills NULL time columns and touches
// nothing else. Close the running ClipCanvas first so SQLite isn't contended.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

app.name = "clipcanvas";
app.commandLine.appendSwitch("enable-precise-memory-info");

// Chromium throttles requestAnimationFrame, timers and IntersectionObserver in
// windows it considers occluded or backgrounded. That made every frame-rate and
// virtualization reading here worthless (idle baseline collapsed to 0.01 FPS).
// These switches keep the renderer running at full speed regardless of whether
// the window is actually front-most, so an automated run measures app cost.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const CFG = {
  workspaceName: flag("workspace", "PERF_TEST"),
  target: Number(flag("target", 10000)),
  width: Number(flag("width", 760)),
  height: Number(flag("height", 640)),
  scrollMs: Number(flag("scroll-ms", 2000)),
  query: flag("query", "perf"),
  out: flag("out", path.join(__dirname, "results", "benchmark_results.json")),
  backfillTime: has("backfill-time"),
  keepOpen: has("keep-open"),
  profile: has("profile"),
  countOps: has("count-ops"),
};

const log = (...a) => console.log("[bench]", ...a);
const fail = (msg) => {
  console.error("\n[bench] ABORT:", msg, "\n");
  app.exit(1);
};

// ── IPC: minimal stand-in for main.js ────────────────────────────────────────
// Mirrors main.js's { success, data } envelope, which preload.js's safeInvoke
// unwraps. Only the channels renderer.js actually calls are registered.
function registerIpc(db, workspaceId) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { success: true, data: await fn(...args) };
      } catch (err) {
        console.error(`[bench] IPC "${channel}" failed:`, err.message);
        return { success: false, error: err.message || String(err) };
      }
    });
  };

  // renderer.js starts with activeWorkspaceId = null and selects workspaces[0],
  // so the benchmark target must come back first or the UI measures the wrong
  // workspace while the data-layer phase measures the right one.
  handle("workspaces:list", () => {
    const all = db.listWorkspaces();
    const target = all.filter((w) => w.id === workspaceId);
    return target.concat(all.filter((w) => w.id !== workspaceId));
  });
  handle("workspaces:setActive", () => ({ ok: true, activeWorkspaceId: workspaceId }));
  handle("boards:list", (wid) => db.listBoards(wid || workspaceId));
  handle("boards:setActive", () => ({ ok: true }));

  handle("clips:getPage", (opts = {}) => db.getClipPage(opts));
  handle("clips:getAll", (opts = {}) => db.getClips(opts));
  handle("clips:getSummaries", (opts = {}) => db.getClipSummaries(opts));
  handle("clips:getById", (id) => db.getClipById(id));
  handle("clips:search", (opts) => db.searchClips(opts));
  handle("clips:trashSummary", ({ workspaceId: w } = {}) =>
    db.getTrashSummary({ workspaceId: w || workspaceId }));

  handle("storage:getStats", ({ workspaceId: w } = {}) =>
    db.getStorageStats({ workspaceId: w || workspaceId }));
  handle("settings:getMaxFileSize", () => 0);

  // The Time Canvas is the default view, so these are hit on every load.
  handle("time:getYears", (wid) => db.getYears(wid || workspaceId));
  handle("time:getMonths", ({ year, workspaceId: w } = {}) => db.getMonths(year, w || workspaceId));
  handle("time:getDays", ({ year, month, workspaceId: w } = {}) =>
    db.getDays(year, month, w || workspaceId));
  handle("time:getHours", ({ year, month, day, workspaceId: w } = {}) =>
    db.getHours(year, month, day, w || workspaceId));
  handle("time:getClipsInTimeRange", ({ startTimestamp, endTimestamp, workspaceId: w } = {}) =>
    db.getClipsInTimeRange(startTimestamp, endTimestamp, w || workspaceId));
  handle("time:getSessions", ({ startTimestamp, endTimestamp, workspaceId: w, gapMinutes } = {}) =>
    db.getSessions(startTimestamp, endTimestamp, w || workspaceId, gapMinutes));
  handle("window:hide", () => null);
}

// ── Injected measurement script ──────────────────────────────────────────────
// Runs inside the real renderer. renderer.js is a classic script, so its
// function declarations (loadMoreClips, renderCanvas) are on window; its
// top-level `let` state is not, so progress is read from the DOM instead.
function measurementScript(cfg, workspaceId) {
  return `(async () => {
  const CFG = ${JSON.stringify(cfg)};
  const WID = ${JSON.stringify(workspaceId)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cards = () => document.querySelectorAll("article.clip-card").length;
  const indicator = () => document.getElementById("load-more-indicator");
  const notes = [];

  // ── 0. Wait for init() to finish its first page ────────────────────────────
  let waited = 0;
  while (waited < 15000) {
    if (cards() > 0 || document.querySelector(".empty-state")) break;
    await sleep(100); waited += 100;
  }
  if (!cards()) return { error: "No clips rendered after 15s - workspace may be empty." };

  // ── 0b. Optional profiling: wrap hot globals to attribute load time ────────
  // renderer.js is a classic script, so its function declarations are on window
  // and can be wrapped without touching the source.
  const prof = {};
  if (CFG.profile) {
    for (const name of ["appendCardsToCanvas", "appendItemsToTimeline", "distributeCards",
                        "buildCardHTML", "bindCardEvents", "updateMinimap",
                        "updateLoadMoreIndicator", "updateCount", "renderCanvas"]) {
      const orig = window[name];
      if (typeof orig !== "function") continue;
      prof[name] = { calls: 0, ms: 0 };
      window[name] = function (...args) {
        const t = performance.now();
        try { return orig.apply(this, args); }
        finally { prof[name].calls++; prof[name].ms += performance.now() - t; }
      };
    }
  }

  // ── 0c. Optional op counting ───────────────────────────────────────────────
  // Wall-clock is unusable in an occluded window, so count the operations that
  // actually drive cost instead. These are deterministic and environment
  // independent: forced-layout reads and listener bindings should grow LINEARLY
  // with clip count. Superlinear growth here is the real regression signal.
  const ops = { getBoundingClientRect: 0, offsetHeight: 0, addEventListener: 0 };
  let counting = false;
  if (CFG.countOps) {
    const gbcr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...a) {
      if (counting) ops.getBoundingClientRect++;
      return gbcr.apply(this, a);
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    if (desc && desc.get) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        enumerable: desc.enumerable,
        get() { if (counting) ops.offsetHeight++; return desc.get.call(this); },
      });
    }
    const ael = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (...a) {
      if (counting) ops.addEventListener++;
      return ael.apply(this, a);
    };
  }

  // ── 1. Drive the real UI to a full load, timed ─────────────────────────────
  counting = true;
  const loadStart = performance.now();
  let pages = 0;
  while (cards() < CFG.target && pages < 500) {
    const ind = indicator();
    if (ind && ind.style.display === "none") break;   // hasMore === false
    const before = cards();
    try {
      await window.loadMoreClips();
    } catch (e) {
      notes.push("loadMoreClips threw: " + e.message);
      break;
    }
    pages++;
    if (cards() === before) break;                    // no forward progress
  }
  const totalLoadAndRenderTimeMs = performance.now() - loadStart;
  counting = false;
  const clipsLoaded = cards();
  if (clipsLoaded < CFG.target) {
    notes.push("Loaded " + clipsLoaded + " of requested " + CFG.target + " clips.");
  }

  // ── 2. Pure render cost of the full set ────────────────────────────────────
  const rStart = performance.now();
  window.renderCanvas();
  void document.body.offsetHeight;                    // force sync layout
  const renderTimeMs = performance.now() - rStart;

  // ── 3. DOM + heap ──────────────────────────────────────────────────────────
  const domNodeCount = document.getElementsByTagName("*").length;
  const virtualizedCards = document.querySelectorAll("article.clip-card.virtualized").length;
  const jsHeapUsedMB = performance.memory
    ? (performance.memory.usedJSHeapSize / 1048576).toFixed(2)
    : null;
  if (jsHeapUsedMB === null) notes.push("performance.memory unavailable - heap not measured.");

  // ── 4. Frame rate ──────────────────────────────────────────────────────────
  // An occluded or backgrounded window has requestAnimationFrame throttled to
  // a crawl, which looks identical to a catastrophically slow renderer. So we
  // sample an IDLE baseline first as a control: if idleFPS is also on the
  // floor, the window was throttled and no FPS number here means anything.
  const sampleFPS = (durationMs, onFrame) =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        const now = performance.now();
        frames++;
        if (onFrame) onFrame();
        if (now - start < durationMs) requestAnimationFrame(tick);
        else resolve(Number((frames / ((now - start) / 1000)).toFixed(2)));
      };
      requestAnimationFrame(tick);
    });

  const idleFPS = await sampleFPS(1000, null);          // control: no work at all

  const scroller = document.getElementById("canvas-scroll");
  scroller.scrollTop = 0;
  const scrollFPS = (await sampleFPS(CFG.scrollMs, () => {
    scroller.scrollTop += 40;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) scroller.scrollTop = 0;
  })).toFixed(2);

  const throttled = idleFPS < 30;
  if (throttled) {
    notes.push(
      "THROTTLED: idle baseline was only " + idleFPS + " FPS with zero work on the " +
      "frame. The window was occluded or backgrounded, so scrollFPS is a measurement " +
      "artifact, not a render cost. Trust scrollStepCostMs/projectedMaxFPS instead."
    );
  }

  // ── 4b. Throttle-immune scroll cost ────────────────────────────────────────
  // rAF only reports how often the compositor CHOSE to draw, which collapses in
  // a backgrounded window. This instead measures the app's actual cost: force a
  // synchronous layout after each scroll step and time it. Independent of
  // whether anything was ever painted, so it is valid in an automated run.
  const SCROLL_STEPS = 60;
  scroller.scrollTop = 0;
  void scroller.offsetHeight;
  const cStart = performance.now();
  for (let i = 0; i < SCROLL_STEPS; i++) {
    scroller.scrollTop += 40;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) scroller.scrollTop = 0;
    void scroller.scrollHeight;          // force synchronous layout
  }
  const scrollStepCostMs = Number(((performance.now() - cStart) / SCROLL_STEPS).toFixed(3));
  const projectedMaxFPS = scrollStepCostMs > 0
    ? Number(Math.min(60, 1000 / scrollStepCostMs).toFixed(1))
    : 60;

  // ── 5. Search latency (FTS5 path) ──────────────────────────────────────────
  const sStart = performance.now();
  let results = [];
  try {
    results = await window.api.search({ query: CFG.query, workspaceId: WID, limit: 200 });
  } catch (e) {
    notes.push("search threw: " + e.message);
  }
  const searchLatencyMs = performance.now() - sStart;

  // ── 6. Data-layer paging: time + bytes actually crossing IPC ───────────────
  let fetchTimeMs = 0, ipcPayloadSizeBytes = 0, clipsFetched = 0;
  let cursorId = null, cursorCreatedAt = null, more = true, guard = 0;
  let firstPageFetchMs = null, firstPagePayloadBytes = null;
  const enc = new TextEncoder();
  while (more && clipsFetched < CFG.target && guard < 500) {
    const t0 = performance.now();
    const page = await window.api.getClipPage({
      workspaceId: WID, boardId: null, filter: "all", limit: 50,
      cursorId, cursorCreatedAt, includePinned: guard === 0,
    });
    const dt = performance.now() - t0;
    const bytes = enc.encode(JSON.stringify(page)).length;
    if (guard === 0) {
      firstPageFetchMs = Number(dt.toFixed(2));
      firstPagePayloadBytes = bytes;
    }
    fetchTimeMs += dt;
    ipcPayloadSizeBytes += bytes;
    clipsFetched += (page.clips || []).length;
    more = !!page.hasMore;
    cursorId = page.nextCursor ? page.nextCursor.id : null;
    cursorCreatedAt = page.nextCursor ? page.nextCursor.createdAt : null;
    guard++;
    if (!cursorId) break;
  }

  return {
    fetchTimeMs, ipcPayloadSizeBytes,
    renderTimeMs, totalLoadAndRenderTimeMs,
    domNodeCount, jsHeapUsedMB,
    searchLatencyMs, searchResultsCount: results.length,
    scrollFPS,
    _detail: {
      idleFPS,
      fpsThrottled: throttled,
      scrollStepCostMs,
      projectedMaxFPS,
      clipsLoadedIntoUI: clipsLoaded,
      clipsFetchedViaPaging: clipsFetched,
      pagesLoaded: pages,
      virtualizedCards,
      liveCards: clipsLoaded - virtualizedCards,
      firstPageFetchMs, firstPagePayloadBytes,
      profile: CFG.profile ? prof : null,
      ops: CFG.countOps ? ops : null,
      notes,
    },
  };
})();`;
}

// ── Run ──────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  let db;
  try {
    db = require("../src/main/db"); // requiring runs migrations
  } catch (err) {
    return fail(
      `Could not open the database: ${err.message}\n` +
      `        If this is a NODE_MODULE_VERSION error, run: npx electron-builder install-app-deps`
    );
  }

  log("DB:", db.db.name);

  // Resolve the workspace
  const ws = db.db.prepare("SELECT id, name FROM workspaces WHERE name = ?").get(CFG.workspaceName);
  if (!ws) {
    return fail(
      `Workspace "${CFG.workspaceName}" does not exist.\n` +
      `        Create the 10k dataset first:  npx electron src/main/generate-perf-dataset.js`
    );
  }

  const total = db.db
    .prepare("SELECT COUNT(*) n FROM clips WHERE workspace_id = ? AND deleted_at IS NULL AND is_archived = 0")
    .get(ws.id).n;
  if (!total) {
    return fail(
      `Workspace "${ws.name}" has no active clips.\n` +
      `        Populate it:  npx electron src/main/generate-perf-dataset.js`
    );
  }
  log(`Workspace "${ws.name}" (id ${ws.id}) - ${total} active clips`);

  // ── Data health: are these clips visible to the time engine? ───────────────
  // generate-perf-dataset.js inserts created_at but NOT year/month/day/hour,
  // and the v5 backfill only runs once at migration time. Rows with NULL year
  // are invisible to getYears/getMonths/getDays/getHours.
  const nullTime = db.db
    .prepare("SELECT COUNT(*) n FROM clips WHERE workspace_id = ? AND year IS NULL")
    .get(ws.id).n;

  if (nullTime) {
    log("");
    log(`!! ${nullTime} of ${total} clips have NULL year/month/day/hour.`);
    log("   The Time Canvas queries (getYears/getMonths/getDays/getHours) filter on");
    log("   those columns, so these clips are INVISIBLE to the time engine.");
    if (CFG.backfillTime) {
      const res = db.db
        .prepare(
          "UPDATE clips SET " +
          "year    = CAST(strftime('%Y', created_at, 'unixepoch', 'localtime') AS INTEGER), " +
          "month   = CAST(strftime('%m', created_at, 'unixepoch', 'localtime') AS INTEGER), " +
          "day     = CAST(strftime('%d', created_at, 'unixepoch', 'localtime') AS INTEGER), " +
          "weekday = CAST(strftime('%w', created_at, 'unixepoch', 'localtime') AS INTEGER), " +
          "hour    = CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER) " +
          "WHERE year IS NULL"
        )
        .run();
      log(`   -> --backfill-time: filled ${res.changes} rows.`);
    } else {
      log("   Re-run with --backfill-time to fix, or ignore (renderer metrics unaffected).");
    }
    log("");
  }

  registerIpc(db, ws.id);

  const win = new BrowserWindow({
    width: CFG.width,
    height: CFG.height,
    show: true, // must be visible: hidden windows throttle requestAnimationFrame
    title: "ClipCanvas Benchmark",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) pageErrors.push(message); // warnings + errors
  });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  // Keep the window unoccluded and focused for the whole run. An occluded
  // window has requestAnimationFrame throttled, which would masquerade as a
  // slow renderer. The idle-FPS control inside the page verifies this worked.
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop();
  win.focus();
  win.webContents.focus();

  log(`Viewport ${CFG.width}x${CFG.height} - measuring (target ${CFG.target} clips)...`);
  log("Leave the benchmark window visible and on top until it finishes.");

  let result;
  try {
    result = await win.webContents.executeJavaScript(measurementScript(CFG, ws.id), true);
  } catch (err) {
    return fail(`Measurement script failed: ${err.message}`);
  }

  if (result && result.error) return fail(result.error);

  const detail = result._detail;
  delete result._detail;

  const payload = {
    ...result,
    _meta: {
      ranAt: new Date().toISOString(),
      workspace: ws.name,
      workspaceId: ws.id,
      activeClipsInWorkspace: total,
      viewport: `${CFG.width}x${CFG.height}`,
      searchQuery: CFG.query,
      scrollSampleMs: CFG.scrollMs,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      ...detail,
      pageErrors: pageErrors.slice(0, 10),
      comparability: [
        "Search now runs through FTS5 with limit clamped to 200 (db.js searchClips).",
        "The June baseline predates both, so searchLatencyMs/searchResultsCount are NOT",
        "directly comparable to it. Render, DOM, heap and FPS numbers are.",
      ],
    },
  };

  fs.writeFileSync(CFG.out, JSON.stringify(payload, null, 2));

  log("");
  log("-- Results ------------------------------------------");
  log(`  scroll cost / step    ${detail.scrollStepCostMs} ms   -> projected max ${detail.projectedMaxFPS} FPS`);
  log(`  scroll FPS (rAF)      ${payload.scrollFPS}${detail.fpsThrottled ? "   << UNRELIABLE, window throttled" : ""}`);
  log(`  idle FPS (control)    ${detail.idleFPS}${detail.fpsThrottled ? "   << window throttled" : ""}`);
  log(`  DOM nodes             ${payload.domNodeCount.toLocaleString()}`);
  log(`  cards live/virtual    ${detail.liveCards} / ${detail.virtualizedCards}`);
  log(`  render (full set)     ${payload.renderTimeMs.toFixed(1)} ms`);
  log(`  load + render total   ${payload.totalLoadAndRenderTimeMs.toFixed(1)} ms`);
  log(`  fetch (all pages)     ${payload.fetchTimeMs.toFixed(1)} ms`);
  log(`  IPC payload           ${(payload.ipcPayloadSizeBytes / 1048576).toFixed(2)} MB`);
  log(`  heap                  ${payload.jsHeapUsedMB} MB`);
  log(`  search "${CFG.query}"  ${payload.searchLatencyMs.toFixed(1)} ms -> ${payload.searchResultsCount} results`);
  log("-----------------------------------------------------");
  if (detail.ops) {
    const n = detail.clipsLoadedIntoUI || 1;
    log("  operations during load (should be LINEAR in clip count):");
    for (const [k, v] of Object.entries(detail.ops)) {
      log(`    ${k.padEnd(24)} ${String(v).padStart(9)}   ${(v / n).toFixed(1).padStart(7)} per clip`);
    }
    log("-----------------------------------------------------");
  }
  if (detail.profile) {
    const rows = Object.entries(detail.profile)
      .filter(([, v]) => v.calls > 0)
      .sort((a, b) => b[1].ms - a[1].ms);
    log("  time attribution during load (self+children, overlapping):");
    for (const [name, v] of rows) {
      const pct = ((v.ms / payload.totalLoadAndRenderTimeMs) * 100).toFixed(1);
      log(`    ${name.padEnd(24)} ${v.ms.toFixed(0).padStart(7)} ms  ${String(v.calls).padStart(6)} calls  ${pct.padStart(5)}%`);
    }
    log("-----------------------------------------------------");
  }
  if (detail.notes.length) detail.notes.forEach((n) => log("  note:", n));
  log("");
  log("Written to", CFG.out);

  if (!CFG.keepOpen) {
    win.destroy();
    app.exit(0);
  }
});

app.on("window-all-closed", () => app.exit(0));
