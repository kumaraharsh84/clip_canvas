// ─── src/main/main.js ────────────────────────────────────────────────────────
// Electron main process: windows, tray, global hotkey, clipboard watcher, IPC.
//
// RECONSTRUCTED after the original source was lost. Behaviour follows what the
// README and planning notes describe and what test/*.js expects:
//   - starts as a tray utility; the panel may start hidden
//   - a global shortcut toggles the panel (Win+Alt+V unless changed in
//     Settings, or taken; see hotkey.js for why it is not Ctrl+Shift+V)
//   - closing the window hides it, it never quits the app
//   - every IPC handler answers { success, data } / { success, error }
//
// The clipboard watcher (clipwatch.js) polls Windows' clipboard sequence
// number and reads the clipboard only when it changes, and skips copies that
// password managers mark as private. Capture can be paused from the tray.
//
// Errors go to a log file (log.js) -- the app runs with no console -- which
// the tray menu opens. The Settings window (renderer/settings.html) changes
// the shortcut, capture, start-up; the tray keeps quick toggles.
// ─────────────────────────────────────────────────────────────────────────────

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
  ipcMain, shell, protocol, screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { ClipDatabase } = require("./db");
const { registerAssetScheme, handleAssetProtocol } = require("./assetProtocol");
// Stored type of a captured clip -- shares its rules with what the canvas shows.
const { classify } = require("./classifyText");
const { ClipboardWatcher } = require("./clipwatch");
const { storeImage, ThumbnailBackfill } = require("./images");
const { Settings } = require("./settings");
const log = require("./log");
const hotkeys = require("./hotkey");
const { ipcHandlers, registerIpc: registerHandlers } = require("./ipc");
const pkg = require("../../package.json");

const IS_DEV = process.argv.includes("--dev");
const POLL_MS = 700;

let win = null;
let tray = null;
let db = null;
let storageDir = null;
let watcher = null;
let thumbs = null;          // makes thumbnails for images stored before there were any
let settings = null;
let captureError = false; // the watcher cannot read the clipboard (see log.js)
let settingsWin = null;
let hotkeyActive = null;     // the registered global shortcut, canonical form
let hotkeyNote = null;       // why the active shortcut is not the expected one
let hotkeySuspended = false; // unregistered while Settings records a new one
let activeWorkspaceId = null;

// A custom scheme must be registered as privileged BEFORE app ready. The
// handler lives in assetProtocol.js so test/verify-app.js tests this exact
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
  // No "hotkey" means the defaults (hotkey.js); one is saved only when chosen.
  settings = new Settings(path.join(userData, "settings.json"), { capturePaused: false });

  // Start with Windows by default (the planning decision), once; after that
  // the tray checkbox decides. Re-registered on every launch so the entry
  // follows the app if its folder moves -- the old Startup-folder .vbs
  // hard-coded a path, and silently stopped working when the project moved.
  // A dev run (npm run dev) leaves the entry alone either way: it used to
  // apply "off" (no setting yet) and delete the entry a normal run had made.
  if (!IS_DEV) {
    if (settings.get("autoStart") === undefined) settings.set("autoStart", true);
    applyAutoStart(!!settings.get("autoStart"));
  }

  const ws = db.listWorkspaces();
  activeWorkspaceId = (ws.find((w) => w.is_default) || ws[0] || {}).id || null;

  // No File/Edit/View menu bar: the canvas and its top bar are the interface.
  // (Text fields keep Ctrl+C / Ctrl+V; Windows handles those without a menu.)
  Menu.setApplicationMenu(null);

  handleAssetProtocol(protocol, storageDir);
  registerIpc();
  createWindow();

  chooseHotkey(settings.get("hotkey"));
  createTray();
  startClipboardWatcher();
  thumbs = new ThumbnailBackfill({
    db, storageDir, nativeImage,
    onError: (file, err) => log.warn("no thumbnail for", file + ":", err.message),
  });
  thumbs.start();
  // `npm run dev -- --settings` opens Settings straight away, for working on it.
  if (IS_DEV && process.argv.includes("--settings")) openSettings();

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
  if (thumbs) thumbs.stop();
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
    icon: appIcon(),
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

  logRendererErrors(win.webContents, "window");
  if (IS_DEV) win.webContents.openDevTools({ mode: "detach" });
}

/**
 * Renderer errors reach the log too. (Electron 35+ puts level and message on
 * the event; older versions passed them as arguments.)
 */
function logRendererErrors(webContents, label) {
  webContents.on("console-message", (e, ...old) => {
    const level = e.level !== undefined ? e.level : old[0];
    const message = e.message !== undefined ? e.message : old[1];
    if (level === 3 || level === "error") log.error(label + ":", message);
  });
}

/** The Settings window: one at a time, closed (not hidden) when dismissed. */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const { height: sh } = screen.getPrimaryDisplay().workAreaSize;
  settingsWin = new BrowserWindow({
    width: 580,
    height: Math.min(800, sh - 40),
    minWidth: 480,
    minHeight: 520,
    show: false,
    backgroundColor: "#0d0f12",
    title: "ClipCanvas Settings",
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin.show());
  // Closed mid-recording: the old shortcut must come back.
  settingsWin.on("closed", () => { settingsWin = null; resumeHotkey(); });
  logRendererErrors(settingsWin.webContents, "settings");
}

function createTray() {
  tray = new Tray(appIcon());
  updateTray();
  tray.on("click", togglePanel);
}

function updateTray() {
  if (!tray) return;
  const paused = !!settings.get("capturePaused");
  tray.setToolTip(captureError ? "ClipCanvas — cannot read the clipboard (see the log)"
    : paused ? "ClipCanvas — capture paused" : "ClipCanvas");
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(captureError
      ? [{ label: "Capture is failing — open the log", click: () => shell.openPath(log.file) },
         { type: "separator" }]
      : []),
    // The shortcut is shown beside the item, not registered by the menu.
    { label: "Open ClipCanvas", click: showPanel,
      ...(hotkeyActive ? { accelerator: hotkeyActive, registerAccelerator: false } : {}) },
    { label: "Settings…", click: openSettings },
    { type: "separator" },
    { label: "Pause capture", type: "checkbox", checked: paused, click: (item) => setPaused(item.checked) },
    { label: "Start with Windows", type: "checkbox", checked: !!settings.get("autoStart"),
      click: (item) => setAutoStart(item.checked) },
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
  broadcast("capture:changed", captureState());
}

function setAutoStart(on) {
  settings.set("autoStart", !!on);
  applyAutoStart(!!on);
  updateTray();
  broadcast("settings:changed", settingsState());
}

// ── Global shortcut ──────────────────────────────────────────────────────────
/**
 * Make `acc` the global shortcut. The new one is registered before the old
 * one is let go, so a shortcut another app already owns leaves the old one
 * working. @returns hotkeys.check()'s result, or an error from registering.
 */
function applyHotkey(acc) {
  const c = hotkeys.check(acc);
  if (!c.ok) { resumeHotkey(); return c; }
  if (c.hotkey === hotkeyActive) { resumeHotkey(); return c; }

  let registered = false;
  try {
    registered = globalShortcut.register(c.hotkey, togglePanel);
  } catch (err) {
    log.error("global shortcut rejected:", c.hotkey, err.message);
  }
  if (!registered) {
    resumeHotkey();
    return { ok: false, error: `${hotkeys.display(c.hotkey)} is already used by another app. Pick another.` };
  }
  if (hotkeyActive && !hotkeySuspended) globalShortcut.unregister(hotkeyActive);
  hotkeySuspended = false;
  hotkeyActive = c.hotkey;
  log.info("global shortcut:", c.hotkey);
  return c;
}

/**
 * Register the saved shortcut, or the first default that is free, and keep
 * the note that explains a substitute (hotkey.choose).
 */
function chooseHotkey(saved) {
  const c = hotkeys.choose(saved || null, (acc) => applyHotkey(acc).ok);
  hotkeyNote = c.note;
  if (c.note) log.warn("global shortcut:", c.note);
}

/**
 * While Settings records a new shortcut, the current one is unregistered --
 * otherwise pressing it (to keep it, say) would toggle the window instead of
 * reaching the recorder.
 */
function suspendHotkey() {
  if (!hotkeyActive || hotkeySuspended) return;
  globalShortcut.unregister(hotkeyActive);
  hotkeySuspended = true;
}

function resumeHotkey() {
  if (!hotkeySuspended) return;
  hotkeySuspended = false;
  let ok = false;
  try { ok = globalShortcut.register(hotkeyActive, togglePanel); } catch (_) {}
  if (!ok) log.warn("could not re-register the global shortcut", hotkeyActive);
}

/** Everything the Settings window shows. */
function settingsState() {
  return {
    hotkey: hotkeyActive,                       // null: none could be registered
    hotkeySaved: settings.get("hotkey") || null, // null: using the defaults
    hotkeyDefault: hotkeys.DEFAULT_HOTKEY,
    hotkeyNote,
    autoStart: !!settings.get("autoStart"),
    dev: IS_DEV,
    capture: captureState(),
    storageDir,
    logFile: log.file,
    stats: db.getStorageStats(), // { clips, images, imageBytes, dbBytes }
    version: app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    homepage: pkg.homepage || null,
  };
}

function captureState() {
  return { paused: !!settings.get("capturePaused"), error: captureError };
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
 * The app icon (src/assets/icon.ico, built from logo.svg by `npm run icons`),
 * then icon.png, then a drawn placeholder. For the tray, which must always get
 * one -- the window starts hidden, so an app with no tray could not be opened
 * -- and for the windows, which in `npm start` would otherwise show Electron's.
 */
function appIcon() {
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
  try {
    watcher = createWatcher();
  } catch (err) {
    // The app still opens -- history stays browsable -- but says capture is down.
    log.error("clipboard watcher cannot start:", err);
    captureError = true;
    updateTray();
    return;
  }
  watcher.setPaused(!!settings.get("capturePaused"));
  watcher.start();
}

function createWatcher() {
  return new ClipboardWatcher({
    clipboard,
    intervalMs: POLL_MS,
    onText: captureText,
    onImage: captureImage,
    onHealth: (ok) => {
      captureError = !ok;
      if (ok) log.info("capture is working again");
      else log.error("capture is failing: the clipboard cannot be read");
      updateTray();
      broadcast("capture:changed", captureState());
    },
  });
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

/** The picture, its thumbnail and the clip row: images.js. */
function captureImage(img, hash) {
  const clip = storeImage({ db, storageDir, img, hash, workspaceId: activeWorkspaceId });
  broadcast("clip:added", clip);
}

/** Send an event to every open window. */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────
// The channels, and what each one answers, are in ipc.js -- the same table
// test/verify-app.js registers. This is the real host behind them.
function registerIpc() {
  const table = ipcHandlers({
    db,
    workspaceId: () => activeWorkspaceId,
    setWorkspace: (id) => { activeWorkspaceId = id; },
    copyBack,
    settingsState,
    setHotkey: (acc) => {
      const r = applyHotkey(acc);
      if (r.ok) {
        // Choosing the default is the same as not choosing: it stays unsaved,
        // so the fallbacks still apply if it is ever taken.
        settings.set("hotkey", r.hotkey === hotkeys.DEFAULT_HOTKEY ? undefined : r.hotkey);
        hotkeyNote = null;
        updateTray();
        broadcast("settings:changed", settingsState());
      }
      return { ...r, state: settingsState() };
    },
    resetHotkey: () => {
      settings.set("hotkey", undefined);
      chooseHotkey(null);
      updateTray();
      broadcast("settings:changed", settingsState());
      return { ok: !!hotkeyActive, hotkey: hotkeyActive, state: settingsState() };
    },
    suspendHotkey: (on) => { if (on) suspendHotkey(); else resumeHotkey(); },
    setAutoStart,
    captureState,
    setPaused,
    openLog: () => { if (log.file) shell.openPath(log.file); return !!log.file; },
    // Only the project's own page: the renderer never picks what gets opened.
    openHomepage: () => { if (pkg.homepage) shell.openExternal(pkg.homepage); return !!pkg.homepage; },
    openSettings,
    openStorage: () => shell.openPath(storageDir),
    hideWindow: () => { if (win) win.hide(); },
  });
  registerHandlers(ipcMain, table, (channel, err) => log.error(`IPC "${channel}":`, err));
}

/**
 * Put a clip back on the clipboard, then tell the watcher, so it does not
 * re-capture what we just wrote and duplicate the clip on every copy-back.
 */
function copyBack(id) {
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
}
