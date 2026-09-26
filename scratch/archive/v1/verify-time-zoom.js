// ─── scratch/verify-time-zoom.js ─────────────────────────────────────────────
// Checks the AutoCAD-style zoom/pan layer on the Time Canvas.
//
// Asserts the roadmap's zoom mapping actually holds:
//   500% years | 400% months | 300% days | 200% hours | 100% clips
// ...that wheel-in enters the box under the pointer, that drag pans without
// navigating, and that "fit" resets.
//
// Usage: npx electron scratch/verify-time-zoom.js [--workspace=NAME]
// Read-only.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.name = "clipcanvas";
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const WORKSPACE = flag("workspace", "Personal");
const log = (...a) => console.log("[zoom]", ...a);

function registerIpc(db, workspaceId) {
  const handle = (c, fn) => ipcMain.handle(c, async (_e, ...a) => {
    try { return { success: true, data: await fn(...a) }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  handle("workspaces:list", () => {
    const all = db.listWorkspaces();
    return all.filter((w) => w.id === workspaceId).concat(all.filter((w) => w.id !== workspaceId));
  });
  handle("workspaces:setActive", () => ({ ok: true }));
  handle("boards:list", (w) => db.listBoards(w || workspaceId));
  handle("boards:setActive", () => ({ ok: true }));
  handle("clips:getPage", (o = {}) => db.getClipPage(o));
  handle("clips:getById", (id) => db.getClipById(id));
  handle("clips:search", (o) => db.searchClips(o));
  handle("clips:trashSummary", () => db.getTrashSummary({ workspaceId }));
  handle("storage:getStats", () => db.getStorageStats({ workspaceId }));
  handle("settings:getMaxFileSize", () => 0);
  handle("time:getYears", (w) => db.getYears(w || workspaceId));
  handle("time:getMonths", ({ year, workspaceId: w } = {}) => db.getMonths(year, w || workspaceId));
  handle("time:getDays", ({ year, month, workspaceId: w } = {}) => db.getDays(year, month, w || workspaceId));
  handle("time:getHours", ({ year, month, day, workspaceId: w } = {}) => db.getHours(year, month, day, w || workspaceId));
  handle("time:getClipsInTimeRange", ({ startTimestamp, endTimestamp, workspaceId: w } = {}) =>
    db.getClipsInTimeRange(startTimestamp, endTimestamp, w || workspaceId));
  handle("time:getSessions", ({ startTimestamp, endTimestamp, workspaceId: w, gapMinutes } = {}) =>
    db.getSessions(startTimestamp, endTimestamp, w || workspaceId, gapMinutes));
  handle("window:hide", () => null);
}

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });

  const state = () => ({
    zoom: q("#time-zoom-label") ? q("#time-zoom-label").textContent : "?",
    scope: q(".time-scope") ? q(".time-scope").textContent.trim() : "?",
    transform: q("#time-surface") ? q("#time-surface").style.transform : "",
    gridSize: q("#time-body") ? q("#time-body").style.getPropertyValue("--grid-size") : "",
    boxes: document.querySelectorAll(".time-box").length,
  });

  let waited = 0;
  while (waited < 15000 && !q("#time-surface")) { await sleep(100); waited += 100; }
  if (!q("#time-surface")) return { error: "Time Canvas surface never rendered." };

  // Wheel over the body. deltaY > 0 = zoom out = higher percentage.
  const wheel = async (deltaY, el) => {
    const target = el || q(".time-body");
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new WheelEvent("wheel", {
      deltaY, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + Math.min(60, r.height / 2),
    }));
    await sleep(220);
  };

  // ── 1. Zoom out through every band: clips -> hour -> day -> month -> year ──
  check("starts at 100% (clips)", state().zoom === "100%", state().zoom + " / " + state().scope);

  // Record the scope each time the LEVEL changes, not each time the % ticks.
  const ladder = [{ zoom: state().zoom, scope: state().scope }];
  for (let i = 0; i < 60; i++) {
    await wheel(120);
    const s = state();
    if (s.scope !== ladder[ladder.length - 1].scope) ladder.push({ zoom: s.zoom, scope: s.scope });
    if (s.zoom === "500%") break;
  }
  check("reaches 500% (years)", state().zoom === "500%", state().zoom + " / " + state().scope);

  // The roadmap ladder: clips -> hours -> days -> months -> years, in order.
  const expect = ["Current Hour", "August 31, 2026", "August 2026", "2026 -", "All years"];
  check("zoomed out through all 5 levels", ladder.length === 5,
        ladder.map((l) => l.zoom + " " + l.scope.slice(0, 22)).join("  |  "));
  ladder.forEach((step, i) => {
    if (i >= expect.length) return;
    check("level " + (i + 1) + " at " + step.zoom + " shows '" + expect[i] + "'",
          step.scope.includes(expect[i]), step.scope);
  });

  // ── 2. Zoom IN over a specific box - it should enter THAT box ──────────────
  const box = document.querySelector(".time-box:not(.is-empty)");
  let enteredLabel = null;
  if (box) {
    enteredLabel = box.querySelector(".tb-label").textContent.trim();
    const r = box.getBoundingClientRect();
    const scopeAtStart = state().scope;
    for (let i = 0; i < 12; i++) {
      q(".time-body").dispatchEvent(new WheelEvent("wheel", {
        deltaY: -120, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      await sleep(160);
      if (state().scope !== scopeAtStart) break;   // wait for a LEVEL change
    }
    check("wheel-in entered the pointed box (" + enteredLabel + ")",
          state().scope.includes(enteredLabel), state().scope);
  }

  // ── 3. Drag pans, and must NOT navigate ───────────────────────────────────
  const scopeBefore = state().scope;
  const body = q(".time-body");
  const br = body.getBoundingClientRect();
  const from = { x: br.left + br.width / 2, y: br.top + br.height / 2 };
  body.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, clientX: from.x, clientY: from.y }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: from.x + 60, clientY: from.y + 34 }));
  await sleep(80);
  const panned = state().transform;
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: from.x + 60, clientY: from.y + 34 }));
  await sleep(120);

  check("drag applied a translate", /translate\\((?!0px, 0px)/.test(panned), panned);
  check("drag did not navigate", state().scope === scopeBefore, state().scope);
  check("grid moved with the pan",
        q("#time-body").style.getPropertyValue("--grid-x") !== "0px",
        q("#time-body").style.getPropertyValue("--grid-x"));

  // ── 4. fit resets pan and zoom ────────────────────────────────────────────
  q("#time-fit").click();
  await sleep(200);
  check("fit reset the pan", /translate\\(0px, 0px\\)/.test(state().transform), state().transform);

  return { results, finalState: state() };
})();`;

app.whenReady().then(async () => {
  const db = require("../src/main/db");
  const ws = db.db.prepare("SELECT id, name FROM workspaces WHERE name = ?").get(WORKSPACE);
  if (!ws) { console.error(`[zoom] workspace "${WORKSPACE}" not found`); return app.exit(1); }
  log(`workspace "${ws.name}" (id ${ws.id})`);
  registerIpc(db, ws.id);

  const win = new BrowserWindow({
    width: 1000, height: 760, show: true, title: "Time Zoom Verify",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, lvl, msg) => { if (lvl >= 2) errors.push(msg); });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  const out = await win.webContents.executeJavaScript(SCRIPT, true);
  if (out.error) { console.error("[zoom] FAILED:", out.error); return app.exit(1); }

  log("");
  let failed = 0;
  for (const r of out.results) {
    log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(46)} ${r.detail || ""}`);
    if (!r.pass) failed++;
  }
  log("");
  log(`final: ${out.finalState.zoom}  ${out.finalState.scope}  grid=${out.finalState.gridSize}`);
  log(failed ? `${failed} check(s) failed` : "all checks passed");
  if (errors.length) errors.slice(0, 6).forEach((e) => log("  renderer: " + e));

  win.destroy();
  app.exit(failed ? 1 : 0);
});

app.on("window-all-closed", () => app.exit(0));
