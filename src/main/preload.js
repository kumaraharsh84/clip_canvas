// ─── src/main/preload.js ─────────────────────────────────────────────────────
// The only bridge between the renderer and the main process.
//
// contextIsolation is ON and nodeIntegration is OFF, so the renderer has no
// require, no fs and no ipcRenderer -- it gets exactly the surface below and
// nothing else. That matters more than usual here: clips hold whatever was on
// the clipboard, which routinely includes tokens and passwords, and a renderer
// that cannot reach the filesystem cannot leak them by accident.
//
// Channels are allow-listed rather than forwarded generically. A generic
// `invoke(channel, ...)` bridge would let any script in the renderer reach any
// handler the main process ever registers, including ones added later with no
// thought to whether the renderer should be able to call them.
//
// Every handler answers with { success, data } or { success, error }; safeInvoke
// unwraps that so callers get the payload and a throw, not an envelope to check.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = [
  // workspaces / boards
  "workspaces:list", "workspaces:setActive", "workspaces:create",
  "boards:list", "boards:setActive", "boards:create", "boards:rename", "boards:delete",

  // clips
  "clips:getPage", "clips:getAll", "clips:getSummaries", "clips:getById",
  "clips:getContent", "clips:search", "clips:update", "clips:delete",
  "clips:restore", "clips:archive", "clips:copyBack", "clips:trashSummary",
  "clips:emptyTrash", "clips:dayCounts", "clips:forDays",

  // time canvas
  "time:getYears", "time:getMonths", "time:getDays", "time:getHours",
  "time:getClipsInTimeRange", "time:getSessions", "time:backfill",

  // app
  "storage:getStats", "storage:openFolder", "settings:getMaxFileSize",
  "window:hide", "window:minimize",
];

const EVENTS = ["clip:added", "clips:changed", "workspace:changed"];

async function safeInvoke(channel, ...args) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Blocked IPC channel: ${channel}`);
  }
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && typeof res === "object" && "success" in res) {
    if (!res.success) throw new Error(res.error || `IPC ${channel} failed`);
    return res.data;
  }
  return res; // handler returned a bare value
}

const api = {
  invoke: safeInvoke,

  /**
   * Subscribe to a main-process event. Returns an unsubscribe function --
   * without one, every re-render that subscribes leaks a listener and the
   * clipboard watcher ends up notifying a hundred dead closures.
   */
  on(event, handler) {
    if (!EVENTS.includes(event)) throw new Error(`Blocked IPC event: ${event}`);
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },

  // Convenience wrappers -- the renderer reads better for them.
  workspaces: {
    list: () => safeInvoke("workspaces:list"),
    setActive: (id) => safeInvoke("workspaces:setActive", id),
    create: (name) => safeInvoke("workspaces:create", name),
  },
  boards: {
    list: (workspaceId) => safeInvoke("boards:list", workspaceId),
    create: (workspaceId, name) => safeInvoke("boards:create", { workspaceId, name }),
    rename: (id, name) => safeInvoke("boards:rename", { id, name }),
    remove: (id) => safeInvoke("boards:delete", id),
  },
  clips: {
    page: (opts) => safeInvoke("clips:getPage", opts),
    summaries: (opts) => safeInvoke("clips:getSummaries", opts),
    byId: (id) => safeInvoke("clips:getById", id),
    content: (id) => safeInvoke("clips:getContent", id),
    search: (opts) => safeInvoke("clips:search", opts),
    update: (id, patch) => safeInvoke("clips:update", { id, patch }),
    remove: (ids) => safeInvoke("clips:delete", ids),
    restore: (ids) => safeInvoke("clips:restore", ids),
    archive: (ids) => safeInvoke("clips:archive", ids),
    copyBack: (id) => safeInvoke("clips:copyBack", id),
    trashSummary: (opts) => safeInvoke("clips:trashSummary", opts),
    emptyTrash: (opts) => safeInvoke("clips:emptyTrash", opts),
    dayCounts: (opts) => safeInvoke("clips:dayCounts", opts),
    forDays: (opts) => safeInvoke("clips:forDays", opts),
  },
  storage: {
    stats: (opts) => safeInvoke("storage:getStats", opts),
    openFolder: () => safeInvoke("storage:openFolder"),
  },
  window: {
    hide: () => safeInvoke("window:hide"),
    minimize: () => safeInvoke("window:minimize"),
  },
};

contextBridge.exposeInMainWorld("api", api);
contextBridge.exposeInMainWorld("clipcanvas", api); // alias
