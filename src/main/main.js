// ─── src/main/main.js ────────────────────────────────────────────────────────
// Electron main process: window, tray, global hotkey, clipboard watcher, IPC.
//
// RECONSTRUCTED after the original source was lost. Behaviour follows what the
// README and planning notes describe and what scratch/*.js expects:
//   - starts as a tray utility; the panel may start hidden
//   - Ctrl+Shift+V toggles the panel
//   - closing the window hides it, it never quits the app
//   - every IPC handler answers { success, data } / { success, error }
//
// The clipboard watcher (clipwatch.js) polls Windows' clipboard sequence
// number and reads the clipboard only when it changes, and skips copies that
// password managers mark as private. Capture can be paused from the tray.
//
// Errors go to a log file (log.js) -- the app runs with no console -- which
// the tray menu opens.
// ─────────────────────────────────────────────────────────────────────────────

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
  ipcMain, shell, protocol, screen,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { ClipDatabase } = require("./db");
const { registerAssetScheme, handleAssetProtocol } = require("./assetProtocol");
// Stored type of a captured clip -- shares its rules with what the canvas shows.
const { classify } = require("./classifyText");
const { ClipboardWatcher } = require("./clipwatch");
const { Settings } = require("./settings");
const log = require("./log");

const IS_DEV = process.argv.includes("--dev");
const POLL_MS = 700;

let win = null;
let tray = null;
let db = null;
let storageDir = null;
let watcher = null;
let settings = null;
let activeWorkspaceId = null;

// A custom scheme must be registered as privileged BEFORE app ready. The
// handler lives in assetProtocol.js so scratch/verify-app.js tests this exact
// code rather than a copy of it.
registerAssetScheme(protocol);

// A tray utility has no one watching its console. Log what would otherwise
// vanish, and keep running: one bad clipboard read must not end capture.
process.on("uncaughtException", (err) => log.error("uncaught exception:", err));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
app.on("render-process-gone", (_e, _wc, d) => log.error("window process gone:", d.reason, "exit code", d.exitCode));
app.on("child-process-gone", (_e, d) => log.error(d.type, "process gone:", d.reason, "exit code", d.exitCode));

// ── Startup ──────────────────────────────────────────────────────────────────
// A clipboard manager must not run twice: two watchers would both capture every
// copy and the history would double up.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());
  app.whenReady().then(start).catch((err) => {
    log.error("startup failed:", err);
    app.exit(1);
  });
}

function start() {
  const userData = app.getPath("userData");
  log.init(path.join(userData, "logs"));
  log.info(`ClipCanvas ${app.getVersion()} starting | Electron ${process.versions.electron} | ${process.platform}`);
  storageDir = path.join(userData, "storage");
  db = new ClipDatabase(path.join(userData, "clipcanvas.db"), storageDir);
  settings = new Settings(path.join(userData, "settings.json"), { capturePaused: false });

  // Start with Windows by default (the planning decision), once; after that
  // the tray checkbox decides. Re-registered on every launch so the entry
  // follows the app if its folder moves -- the old Startup-folder .vbs
  // hard-coded a path, and silently stopped working when the project moved.
  if (settings.get("autoStart") === undefined && !IS_DEV) settings.set("autoStart", true);
  applyAutoStart(!!settings.get("autoStart"));

  const ws = db.listWorkspaces();
  activeWorkspaceId = (ws.find((w) => w.is_default) || ws[0] || {}).id || null;

  handleAssetProtocol(protocol, storageDir);
  registerIpc();
  createWindow();
  createTray();

  globalShortcut.register("CommandOrControl+Shift+V", togglePanel);
  startClipboardWatcher();

  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}

app.on("window-all-closed", (e) => {
  // Tray utility: closing the panel must not end the process.
  e.preventDefault && e.preventDefault();
});

app.on("will-quit", () => {
  log.info("quitting");
  globalShortcut.unregisterAll();
  if (watcher) watcher.stop();
  if (db) db.close();
});

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: Math.min(1180, Math.round(sw * 0.8)),
    height: Math.min(780, Math.round(sh * 0.85)),
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: true,
    backgroundColor: "#0d0f12",
    title: "ClipCanvas",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only contextBridge and ipcRenderer, both available
      // in the sandbox, so the renderer gets no Node at all.
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => { if (IS_DEV) showPanel(); });

  // Close hides. Only an explicit tray Quit actually exits.
  win.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });

  // Renderer errors reach the log too. (Electron 35+ puts level and message on
  // the event; older versions passed them as arguments.)
  win.webContents.on("console-message", (e, ...old) => {
    const level = e.level !== undefined ? e.level : old[0];
    const message = e.message !== undefined ? e.message : old[1];
    if (level === 3 || level === "error") log.error("window:", message);
  });

  if (IS_DEV) win.webContents.openDevTools({ mode: "detach" });
}

function createTray() {
  tray = new Tray(trayIcon());
  updateTray();
  tray.on("click", togglePanel);
}

function updateTray() {
  if (!tray) return;
  const paused = !!settings.get("capturePaused");
  tray.setToolTip(paused ? "ClipCanvas — capture paused" : "ClipCanvas");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open ClipCanvas", click: showPanel },
    { type: "separator" },
    { label: "Pause capture", type: "checkbox", checked: paused, click: (item) => setPaused(item.checked) },
    { label: "Start with Windows", type: "checkbox", checked: !!settings.get("autoStart"),
      click: (item) => { settings.set("autoStart", item.checked); applyAutoStart(item.checked); } },
    { type: "separator" },
    { label: "Open storage folder", click: () => shell.openPath(storageDir) },
    { label: "Open log file", enabled: !!log.file, click: () => shell.openPath(log.file) },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function setPaused(paused) {
  settings.set("capturePaused", !!paused);
  if (watcher) watcher.setPaused(!!paused);
  updateTray();
  broadcast("capture:changed", { paused: !!paused });
}

/**
 * Register (or remove) the "run at login" entry. Measured quirks of
 * setLoginItemSettings on Windows: it strips backslashes from `args` and does
 * not quote `path`. So the app folder is passed with forward slashes, and
 * anything containing a space is quoted here.
 */
function applyAutoStart(enabled) {
  try {
    const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
    const args = app.isPackaged ? [] : [quote(app.getAppPath().replace(/\\/g, "/"))];
    app.setLoginItemSettings({ openAtLogin: enabled, path: quote(process.execPath), args, name: "ClipCanvas" });
  } catch (err) {
    log.error("could not update start-with-Windows:", err.message);
  }
}

/**
 * src/assets/icon.ico, then icon.png, then a drawn placeholder. The tray must
 * always get an icon: the window starts hidden, so an app with no tray would
 * have no way to be opened.
 */
function trayIcon() {
  const icoPath = path.join(__dirname, "..", "assets", "icon.ico");
  if (fs.existsSync(icoPath)) return nativeImage.createFromPath(icoPath);

  const pngPath = path.join(__dirname, "..", "assets", "icon.png");
  if (fs.existsSync(pngPath)) return nativeImage.createFromPath(pngPath);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect width="32" height="32" rx="7" fill="#16222e"/>
    <rect x="7" y="6" width="18" height="6" rx="2" fill="#6fa8dc"/>
    <rect x="7" y="14" width="13" height="4" rx="1.5" fill="#7fd1b9"/>
    <rect x="7" y="21" width="18" height="4" rx="1.5" fill="#b48ead"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")
  );
}

function showPanel() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function togglePanel() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else showPanel();
}

// ── Clipboard watcher ────────────────────────────────────────────────────────
function startClipboardWatcher() {
  watcher = new ClipboardWatcher({
    clipboard,
    intervalMs: POLL_MS,
    onText: captureText,
    // PNG is encoded only here, once per captured image -- never to check.
    onImage: (img, hash) => captureImage(img.toPNG(), hash, img.getSize()),
  });
  watcher.setPaused(!!settings.get("capturePaused"));
  watcher.start();
}

function captureText(text) {
  if (db.findRecentDuplicate(activeWorkspaceId, classify(text), text)) return;
  const clip = db.addClip({
    type: classify(text),
    content: text,
    workspace_id: activeWorkspaceId,
    source: "clipboard",
    file_size_bytes: Buffer.byteLength(text, "utf8"),
    storage_mode: "inline",
  });
  broadcast("clip:added", clip);
}

function captureImage(png, hash, size) {
  const now = new Date();
  const rel = path.join(
    "images",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    `img-${crypto.randomUUID()}.png`
  ).replace(/\\/g, "/");

  const full = path.join(storageDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, png);

  const clip = db.addClip({
    type: "image",
    content: null,
    workspace_id: activeWorkspaceId,
    source: "clipboard",
    storage_mode: "local",
    asset_path: rel,
    asset_hash: hash,
    mime_type: "image/png",
    file_size_bytes: png.length,
    title: `Image ${size.width}x${size.height}`,
  });
  broadcast("clip:added", clip);
}

/** Send an event to every open window. */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  // Every handler returns the same envelope preload.safeInvoke unwraps, and a
  // throw becomes { success: false } rather than an unhandled rejection that
  // leaves the renderer waiting forever.
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { success: true, data: await fn(...args) };
      } catch (err) {
        log.error(`IPC "${channel}":`, err);
        return { success: false, error: err.message || String(err) };
      }
    });
  };

  handle("workspaces:list", () => db.listWorkspaces());
  handle("workspaces:create", (name) => db.createWorkspace(name));
  handle("workspaces:setActive", (id) => {
    activeWorkspaceId = id;
    broadcast("workspace:changed", id);
    return { ok: true, activeWorkspaceId };
  });

  handle("boards:list", (wid) => db.listBoards(wid || activeWorkspaceId));
  handle("boards:setActive", () => ({ ok: true }));
  handle("boards:create", ({ workspaceId, name }) =>
    db.createBoard(workspaceId || activeWorkspaceId, name));
  handle("boards:rename", ({ id, name }) => db.renameBoard(id, name));
  handle("boards:delete", (id) => db.deleteBoard(id));

  handle("clips:getPage", (opts = {}) => db.getClipPage(withWorkspace(opts)));
  handle("clips:getAll", (opts = {}) => db.getClips(withWorkspace(opts)));
  handle("clips:getSummaries", (opts = {}) => db.getClipSummaries(withWorkspace(opts)));
  handle("clips:getById", (id) => db.getClipById(id));
  handle("clips:getContent", (id) => db.getClipContent(id));
  handle("clips:search", (opts = {}) => db.searchClips(withWorkspace(opts)));
  handle("clips:update", ({ id, patch }) => db.updateClip(id, patch));
  handle("clips:delete", (ids) => db.deleteClips(toArray(ids)));
  handle("clips:restore", (ids) => db.restoreClips(toArray(ids)));
  handle("clips:archive", (ids) => db.archiveClips(toArray(ids)));
  handle("clips:trashSummary", (opts = {}) => db.getTrashSummary(withWorkspace(opts)));
  handle("clips:emptyTrash", (opts = {}) => db.emptyTrash(withWorkspace(opts)));

  handle("clips:dayCounts", (opts = {}) => db.getDayCounts(withWorkspace(opts)));
  handle("clips:forDays", (opts = {}) => db.getClipsForDays(withWorkspace(opts)));

  /**
   * Put a clip back on the clipboard, then tell the watcher, so it does not
   * re-capture what we just wrote and duplicate the clip on every copy-back.
   */
  handle("clips:copyBack", (id) => {
    const clip = db.getClipById(id);
    if (!clip) throw new Error("clip not found");

    if (clip.type === "image" && clip.asset_path) {
      const img = nativeImage.createFromPath(path.join(storageDir, clip.asset_path));
      if (img.isEmpty()) throw new Error("image asset missing");
      clipboard.writeImage(img);
    } else {
      clipboard.writeText(clip.content || "");
    }
    if (watcher) watcher.noteOwnWrite();
    return { ok: true, id };
  });

  handle("capture:getState", () => ({ paused: !!settings.get("capturePaused") }));
  handle("capture:setPaused", (paused) => { setPaused(paused); return { paused: !!paused }; });

  handle("time:getYears", (wid) => db.getYears(wid || activeWorkspaceId));
  handle("time:getMonths", ({ year, workspaceId } = {}) =>
    db.getMonths(year, workspaceId || activeWorkspaceId));
  handle("time:getDays", ({ year, month, workspaceId } = {}) =>
    db.getDays(year, month, workspaceId || activeWorkspaceId));
  handle("time:getHours", ({ year, month, day, workspaceId } = {}) =>
    db.getHours(year, month, day, workspaceId || activeWorkspaceId));
  handle("time:getClipsInTimeRange", ({ startTimestamp, endTimestamp, workspaceId } = {}) =>
    db.getClipsInTimeRange(startTimestamp, endTimestamp, workspaceId || activeWorkspaceId));
  handle("time:getSessions", ({ startTimestamp, endTimestamp, workspaceId, gapMinutes } = {}) =>
    db.getSessions(startTimestamp, endTimestamp, workspaceId || activeWorkspaceId, gapMinutes));
  handle("time:backfill", () => db.backfillTimeColumns());

  handle("storage:getStats", (opts = {}) => db.getStorageStats(withWorkspace(opts)));
  handle("storage:openFolder", () => { shell.openPath(storageDir); return { ok: true }; });
  handle("settings:getMaxFileSize", () => 0);

  handle("window:hide", () => { if (win) win.hide(); return null; });
  handle("window:minimize", () => { if (win) win.minimize(); return null; });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function withWorkspace(opts) {
  return { ...opts, workspaceId: opts.workspaceId || activeWorkspaceId };
}
function toArray(v) { return Array.isArray(v) ? v : [v]; }

module.exports = { classify };
