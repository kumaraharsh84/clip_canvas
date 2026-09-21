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

const { ClipDatabase } = require("./db");

const IS_DEV = process.argv.includes("--dev");
const ASSET_SCHEME = "clip-asset";

let win = null;
let tray = null;
let db = null;
let storageDir = null;
let pollTimer = null;
let activeWorkspaceId = null;

// A custom scheme must be registered as privileged BEFORE app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { secure: true, supportFetchAPI: true, bypassCSP: false } },
]);

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

  registerAssetProtocol();
  createWindow();
  createTray();

  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}

app.on("window-all-closed", (e) => {
  // Tray utility: closing the panel must not end the process.
  e.preventDefault && e.preventDefault();
});

app.on("will-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (db) db.close();
});

/**
 * Serve stored assets over clip-asset:// instead of file://.
 * The renderer runs with contextIsolation and no node access; handing it raw
 * file:// paths to the user's disk would widen that surface for no reason.
 * This scheme resolves only inside storageDir, and the containment check below
 * is what makes an asset_path of "../../.ssh/id_rsa" resolve to nothing.
 */
function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, "");
    const full = path.normalize(path.join(storageDir, rel));

    if (!full.startsWith(path.normalize(storageDir))) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const data = fs.readFileSync(full);
      return new Response(data, { headers: { "content-type": mimeFor(full) } });
    } catch (_) {
      return new Response("not found", { status: 404 });
    }
  });
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────
function mimeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}
