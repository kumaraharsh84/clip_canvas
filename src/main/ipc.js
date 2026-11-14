// ─── src/main/ipc.js ─────────────────────────────────────────────────────────
// Every channel the windows may call, in one table.
//
// main.js and test/verify-app.js both register THIS table, so the app and its
// end-to-end check cannot disagree about which channels exist. What differs
// between them is the host: main.js passes the real tray, shortcut and
// clipboard; the test passes stand-ins, so it never takes a shortcut or
// writes to anyone's clipboard.
//
// preload.js cannot load this file (a sandboxed preload may only require
// "electron"), so it keeps its own allow-list. test/verify-ipc.js checks that
// the two lists are the same, and that every event main.js sends is one the
// preload lets through.
//
// Pure: no Electron here. Everything Electron-shaped comes in through `host`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}   host
 * @param {object}   host.db               ClipDatabase
 * @param {function} host.workspaceId      () => id of the active workspace
 * @param {function} host.setWorkspace     (id) => void
 * @param {function} host.copyBack         (id) => put that clip on the clipboard
 * @param {function} host.settingsState    () => everything the Settings window shows
 * @param {function} host.setHotkey        (accelerator) => { ok, hotkey?, error?, warning?, state }
 * @param {function} host.resetHotkey      () => { ok, hotkey, state }
 * @param {function} host.suspendHotkey    (on) => void
 * @param {function} host.setAutoStart     (on) => void
 * @param {function} host.captureState     () => { paused, error }
 * @param {function} host.setPaused        (paused) => void
 * @param {function} host.openLog          () => boolean, whether there is a log
 * @param {function} host.openHomepage     () => boolean, whether there is a page
 * @param {function} host.openSettings     () => void
 * @param {function} host.openStorage      () => void
 * @param {function} host.hideWindow       () => void
 * @returns {Object<string, function>} channel -> handler
 */
function ipcHandlers(host) {
  const { db } = host;
  const scoped = (opts = {}) => ({ ...opts, workspaceId: opts.workspaceId || host.workspaceId() });
  const list = (v) => (Array.isArray(v) ? v : [v]);

  return {
    // workspaces / boards
    "workspaces:list": () => db.listWorkspaces(),
    "workspaces:create": (name) => db.createWorkspace(name),
    "workspaces:setActive": (id) => {
      host.setWorkspace(id);
      return { ok: true, activeWorkspaceId: host.workspaceId() };
    },
    "boards:list": (workspaceId) => db.listBoards(workspaceId || host.workspaceId()),
    "boards:create": ({ workspaceId, name }) => db.createBoard(workspaceId || host.workspaceId(), name),
    "boards:rename": ({ id, name }) => db.renameBoard(id, name),
    "boards:delete": (id) => db.deleteBoard(id),

    // clips
    "clips:search": (opts) => db.searchClips(scoped(opts)),
    "clips:update": ({ id, patch }) => db.updateClip(id, patch),
    "clips:delete": (ids) => db.deleteClips(list(ids)),
    "clips:restore": (ids) => db.restoreClips(list(ids)),
    "clips:copyBack": async (id) => { await host.copyBack(id); return { ok: true, id }; },
    "clips:trashSummary": (opts) => db.getTrashSummary(scoped(opts)),
    "clips:emptyTrash": (opts) => db.emptyTrash(scoped(opts)),
    "clips:dayCounts": (opts) => db.getDayCounts(scoped(opts)),
    "clips:forDays": (opts) => db.getClipsForDays(scoped(opts)),

    // app
    "storage:openFolder": () => { host.openStorage(); return { ok: true }; },
    "window:hide": () => { host.hideWindow(); return null; },
    "capture:getState": () => host.captureState(),
    "capture:setPaused": (paused) => { host.setPaused(paused); return host.captureState(); },
    "settings:get": () => host.settingsState(),
    "settings:setHotkey": (accelerator) => host.setHotkey(accelerator),
    "settings:resetHotkey": () => host.resetHotkey(),
    "settings:suspendHotkey": (on) => { host.suspendHotkey(!!on); return true; },
    "settings:setAutoStart": (on) => { host.setAutoStart(!!on); return host.settingsState(); },
    "app:openLog": () => ({ ok: !!host.openLog() }),
    "app:openHomepage": () => ({ ok: !!host.openHomepage() }),
    "window:openSettings": () => { host.openSettings(); return null; },
  };
}

/**
 * Register a table of handlers. Every handler answers with the envelope
 * preload.safeInvoke unwraps, and a throw becomes { success: false } rather
 * than an unhandled rejection that leaves the window waiting forever.
 * @param {function} [onError] (channel, err) => void
 */
function registerIpc(ipcMain, table, onError = () => {}) {
  for (const [channel, fn] of Object.entries(table)) {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { success: true, data: await fn(...args) };
      } catch (err) {
        onError(channel, err);
        return { success: false, error: err.message || String(err) };
      }
    });
  }
}

module.exports = { ipcHandlers, registerIpc };
