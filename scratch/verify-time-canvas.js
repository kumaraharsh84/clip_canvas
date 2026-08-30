// ─── scratch/verify-time-canvas.js ───────────────────────────────────────────
// Integration check for the Time Canvas.
//
// Drives the real renderer through Year > Month > Day > Hour > Clips, clicking
// the actual boxes, and asserts each level renders. Also records the DOM node
// count at every level, which is the whole claim behind the design: cost is
// bounded by the LEVEL, not by how many clips exist.
//
// Usage:
//   npx electron scratch/verify-time-canvas.js [--workspace=NAME]
//
// Read-only. Does not modify any clip.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.name = "clipcanvas";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const WORKSPACE = flag("workspace", "PERF_TEST");

const log = (...a) => console.log("[verify]", ...a);

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
  handle("workspaces:list", () => {
    const all = db.listWorkspaces();
    return all.filter((w) => w.id === workspaceId).concat(all.filter((w) => w.id !== workspaceId));
  });
  handle("workspaces:setActive", () => ({ ok: true }));
  handle("boards:list", (wid) => db.listBoards(wid || workspaceId));
  handle("boards:setActive", () => ({ ok: true }));
  handle("clips:getPage", (o = {}) => db.getClipPage(o));
  handle("clips:getById", (id) => db.getClipById(id));
  handle("clips:search", (o) => db.searchClips(o));
  handle("clips:trashSummary", () => db.getTrashSummary({ workspaceId }));
  handle("storage:getStats", () => db.getStorageStats({ workspaceId }));
  handle("settings:getMaxFileSize", () => 0);
  handle("time:getYears", (wid) => db.getYears(wid || workspaceId));
  handle("time:getMonths", ({ year, workspaceId: w } = {}) => db.getMonths(year, w || workspaceId));
  handle("time:getDays", ({ year, month, workspaceId: w } = {}) => db.getDays(year, month, w || workspaceId));
  handle("time:getHours", ({ year, month, day, workspaceId: w } = {}) =>
    db.getHours(year, month, day, w || workspaceId));
  handle("time:getClipsInTimeRange", ({ startTimestamp, endTimestamp, workspaceId: w } = {}) =>
    db.getClipsInTimeRange(startTimestamp, endTimestamp, w || workspaceId));
  handle("time:getSessions", ({ startTimestamp, endTimestamp, workspaceId: w, gapMinutes } = {}) =>
    db.getSessions(startTimestamp, endTimestamp, w || workspaceId, gapMinutes));
  handle("window:hide", () => null);
}

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = [];
  const q  = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  const snapshot = (name) => ({
    step: name,
    level: q("#time-container .time-scope") ? q("#time-container .time-scope").textContent.trim() : "(none)",
    breadcrumb: qa("#time-container .crumb").map((c) => c.textContent.trim()).join(" > "),
    boxes: qa("#time-container .time-box").length,
    emptyBoxes: qa("#time-container .time-box.is-empty").length,
    nowBoxes: qa("#time-container .time-box.is-now").length,
    cards: qa("#time-container article.clip-card").length,
    domNodes: document.getElementsByTagName("*").length,
  });

  // Wait for the Time Canvas to paint its default (current hour) view.
  let waited = 0;
  while (waited < 15000 && !q("#time-container .time-scope")) { await sleep(100); waited += 100; }
  if (!q("#time-container .time-scope")) return { error: "Time Canvas never rendered." };
  steps.push(snapshot("default (current hour)"));

  const clickAndWait = async (el, label) => {
    if (!el) { steps.push({ step: label, error: "target not found" }); return false; }
    el.click();
    await sleep(400);
    steps.push(snapshot(label));
    return true;
  };

  // Up to the year level via the breadcrumb root.
  await clickAndWait(qa("#time-container .crumb").find((c) => c.dataset.goto === "year"), "year level");

  // Drill back down, always choosing a box that actually holds clips.
  const firstNonEmpty = () => qa("#time-container .time-box:not(.is-empty)")[0];

  await clickAndWait(firstNonEmpty(), "month level (clicked a year)");
  await clickAndWait(firstNonEmpty(), "day level (clicked a month)");
  await clickAndWait(firstNonEmpty(), "hour level (clicked a day)");
  await clickAndWait(firstNonEmpty(), "clips level (clicked an hour)");

  // The "now" shortcut should return to the live hour from anywhere.
  await clickAndWait(q("#time-now"), "jump to now");

  return { steps };
})();`;

app.whenReady().then(async () => {
  const db = require("../src/main/db");
  const ws = db.db.prepare("SELECT id, name FROM workspaces WHERE name = ?").get(WORKSPACE);
  if (!ws) { console.error(`[verify] workspace "${WORKSPACE}" not found`); return app.exit(1); }

  const active = db.db.prepare(
    "SELECT COUNT(*) n FROM clips WHERE workspace_id = ? AND deleted_at IS NULL AND is_archived = 0"
  ).get(ws.id).n;
  log(`workspace "${ws.name}" (id ${ws.id}) - ${active} active clips`);

  registerIpc(db, ws.id);

  const win = new BrowserWindow({
    width: 900, height: 700, show: true, title: "Time Canvas Verify",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "main", "preload.js"),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  const result = await win.webContents.executeJavaScript(SCRIPT, true);
  if (result.error) { console.error("[verify] FAILED:", result.error); return app.exit(1); }

  log("");
  log("step                            boxes  empty  now  cards   DOM   scope");
  log("-".repeat(104));
  for (const s of result.steps) {
    if (s.error) { log(`${s.step.padEnd(30)} ERROR: ${s.error}`); continue; }
    log(
      s.step.padEnd(30) +
      String(s.boxes).padStart(6) +
      String(s.emptyBoxes).padStart(7) +
      String(s.nowBoxes).padStart(5) +
      String(s.cards).padStart(7) +
      String(s.domNodes).padStart(6) +
      "   " + s.level
    );
  }
  log("-".repeat(104));
  const peak = Math.max(...result.steps.filter((s) => !s.error).map((s) => s.domNodes));
  log(`peak DOM nodes across all levels: ${peak.toLocaleString()}  (workspace holds ${active.toLocaleString()} clips)`);
  if (errors.length) {
    log("");
    log("renderer warnings/errors:");
    errors.slice(0, 8).forEach((e) => log("  " + e));
  }

  win.destroy();
  app.exit(0);
});

app.on("window-all-closed", () => app.exit(0));
