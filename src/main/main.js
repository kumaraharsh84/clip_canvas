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
// The clipboard watcher polls. Electron exposes no clipboard-change event on
// Windows, and the alternatives (a native clipboard-listener addon, or a
// hidden window subscribing to WM_CLIPBOARDUPDATE) both mean another native
// dependency to rebuild against every Electron bump -- which is exactly the
// class of breakage this project has already lost a day to.
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

const IS_DEV = process.argv.includes("--dev");
const POLL_MS = 700;

let win = null;
let tray = null;
let db = null;
let storageDir = null;
let pollTimer = null;
let activeWorkspaceId = null;

// Last seen clipboard state, so a poll that finds nothing new does nothing.
let lastText = null;
let lastImageHash = null;

// A custom scheme must be registered as privileged BEFORE app ready. The
// handler lives in assetProtocol.js so scratch/verify-app.js tests this exact
// code rather than a copy of it.
registerAssetScheme(protocol);

// ── Startup ──────────────────────────────────────────────────────────────────
// A clipboard manager must not run twice: two watchers would both capture every
// copy and the history would double up.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());
  app.whenReady().then(start).catch((err) => {
    console.error("[clipcanvas] startup failed:", err);
    app.exit(1);
  });
}

function start() {
  const userData = app.getPath("userData");
  storageDir = path.join(userData, "storage");
  db = new ClipDatabase(path.join(userData, "clipcanvas.db"), storageDir);

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
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
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
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => { if (IS_DEV) showPanel(); });

  // Close hides. Only an explicit tray Quit actually exits.
  win.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });

  if (IS_DEV) win.webContents.openDevTools({ mode: "detach" });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("ClipCanvas");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open ClipCanvas", click: showPanel },
    { type: "separator" },
    { label: "Open storage folder", click: () => shell.openPath(storageDir) },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", togglePanel);
}

/**
 * The packaged build references src/assets/icon.ico, which did not survive.
 * Rather than fail to create a tray at all -- which would leave the app with no
 * way to be opened, since the window starts hidden -- draw a placeholder.
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
  // Prime from the current clipboard so whatever is already on it at launch is
  // not captured as if it were just copied.
  lastText = clipboard.readText() || null;
  const img = clipboard.readImage();
  lastImageHash = img.isEmpty() ? null : hashBuffer(img.toPNG());

  pollTimer = setInterval(pollClipboard, POLL_MS);
}

function pollClipboard() {
  try {
    // Images first: copying an image often leaves a text representation too
    // (a filename, or HTML), and capturing that instead loses the picture.
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const png = img.toPNG();
      const hash = hashBuffer(png);
      if (hash !== lastImageHash) {
        lastImageHash = hash;
        lastText = clipboard.readText() || lastText;
        captureImage(png, hash, img.getSize());
      }
      return;
    }

    const text = clipboard.readText();
    if (text && text !== lastText) {
      lastText = text;
      lastImageHash = null;
      captureText(text);
    }
  } catch (err) {
    console.error("[clipcanvas] clipboard poll failed:", err.message);
  }
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

/** text | code | url -- the same three the canvas colours by. */
function classify(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return "url";

  const codey = [
    /[{};]\s*$/m, /^\s*(function|class|const|let|var|import|export|def|public|private)\b/m,
    /^\s*(if|for|while|switch|return)\s*\(/m, /=>/, /^\s*<\/?[a-z][\w-]*[\s>]/im,
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)\s/im,
  ].reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);

  const lines = t.split("\n");
  const indented = lines.filter((l) => /^\s{2,}|\t/.test(l)).length;
  if (codey >= 2 || (codey >= 1 && indented >= 2)) return "code";
  return "text";
}

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
        console.error(`[clipcanvas] IPC "${channel}":`, err);
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

  /**
   * Put a clip back on the clipboard. lastText/lastImageHash are updated first
   * so the watcher does not immediately re-capture what we just wrote and
   * duplicate the clip on every copy-back.
   */
  handle("clips:copyBack", (id) => {
    const clip = db.getClipById(id);
    if (!clip) throw new Error("clip not found");

    if (clip.type === "image" && clip.asset_path) {
      const img = nativeImage.createFromPath(path.join(storageDir, clip.asset_path));
      if (img.isEmpty()) throw new Error("image asset missing");
      lastImageHash = hashBuffer(img.toPNG());
      clipboard.writeImage(img);
    } else {
      lastText = clip.content || "";
      clipboard.writeText(lastText);
    }
    return { ok: true, id };
  });

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
function hashBuffer(buf) { return crypto.createHash("sha1").update(buf).digest("hex"); }

module.exports = { classify };
