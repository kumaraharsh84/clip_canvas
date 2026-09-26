// ─── src/renderer/renderer.js ────────────────────────────────────────────────
// UI shell around the Time Canvas.
//
// This process has no require and no filesystem (contextIsolation is on), so
// everything goes through window.api from preload.js, and the canvas engine
// arrives as timecanvas.bundle.js -- rebuild it with `npm run bundle` after
// editing anything under src/renderer/canvas/.
//
// The canvas asks for data itself, through the source built in makeSource():
// clip counts per day for the whole history, and full clips only for the days
// on screen. Every change here (a capture, an edit, a filter) therefore comes
// down to tc.refresh() or tc.setSource() -- never "reload everything".
//
// Navigation keys (F, T, +/-, arrows, Backspace) belong to the canvas
// controls. This file handles app-level keys: "/" to search, Ctrl+, for
// Settings, Escape to close.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const { mountTimeCanvas, mountTimelineStrip } = window.ClipCanvasTimeCanvas;
  const api = window.api;

  const $ = (id) => document.getElementById(id);
  const el = {
    workspace: $("workspace"), board: $("board"), filter: $("filter"),
    search: $("search"), today: $("today"), fit: $("fit"), reload: $("reload"),
    capture: $("capture"), emptyTrash: $("empty-trash"), settings: $("settings"),
    status: $("status"),
    stage: $("time-container"), hud: $("hud"), details: $("details"),
    results: $("results"), empty: $("empty"), legend: $("legend"), timeline: $("timeline"),
    infoPath: $("info-path"), infoTitle: $("info-title"),
    infoMeta: $("info-meta"), infoCats: $("info-cats"),
    dType: $("d-type"), dWhen: $("d-when"), dTitle: $("d-title"),
    dBody: $("d-bodywrap"), dMeta: $("d-meta"), dClose: $("d-close"),
    dCopy: $("d-copy"), dStar: $("d-star"), dPin: $("d-pin"),
    dArchive: $("d-archive"), dDelete: $("d-delete"), dRestore: $("d-restore"),
  };

  let tc = null;
  let selected = null;
  let selectedNode = null;
  let refreshTimer = null;
  let infoRaf = null;
  let hovered = null;
  let searchTimer = null;
  let searchSeq = 0;
  let hits = [];
  let activeHit = -1;
  let paused = false;

  init().catch(fatal);

  async function init() {
    tc = mountTimeCanvas(el.stage, {
      onSelect,
      onFrame,
      onHover: (node) => { hovered = node; scheduleInfo(); },
      // Assets are served by the clip-asset:// handler registered in main.js,
      // which resolves only inside the storage folder.
      resolveImage: (clip) =>
        clip.asset_path
          ? "clip-asset://" + String(clip.asset_path).replace(/\\/g, "/")
          : clip.content,
    });
    mountTimelineStrip(el.timeline, tc);
    tc.onData(onData);

    // Handle for the headless harnesses in test/ to drive the camera and
    // read layout state. Deliberately the only global this file creates.
    window.__tc = tc;

    wireEvents();
    await Promise.all([loadWorkspaces(), loadCaptureState()]);
    // The app opens on today: the current day is the working place, and the
    // rest of history is one zoom-out away (planning/chat-decisions.md).
    await tc.setSource(makeSource(), { view: "today" });
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function loadWorkspaces() {
    const ws = await api.workspaces.list();
    el.workspace.innerHTML = ws
      .map((w) => `<option value="${w.id}">${esc(w.name)} (${w.clip_count})</option>`)
      .join("");

    const active = ws.find((w) => w.is_default && w.clip_count > 0) ||
                   ws.find((w) => w.clip_count > 0) || ws[0];
    if (active) {
      el.workspace.value = String(active.id);
      await api.workspaces.setActive(active.id);
    }
    await loadBoards();
  }

  async function loadBoards() {
    const boards = await api.boards.list(Number(el.workspace.value));
    el.board.innerHTML = '<option value="">All boards</option>' +
      boards.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.clip_count})</option>`).join("");
  }

  /** What the canvas loads through: the current workspace, board and filter. */
  function makeSource() {
    const opts = {
      workspaceId: Number(el.workspace.value) || undefined,
      boardId: Number(el.board.value) || undefined,
      filter: el.filter.value,
    };
    return {
      dayCounts: () => api.clips.dayCounts(opts),
      forDays: (days) => api.clips.forDays({ ...opts, days }),
    };
  }

  /** Filters, workspace or board changed: same place in time, different clips. */
  async function resource() {
    el.emptyTrash.hidden = el.filter.value !== "trash";
    deselect();
    status("loading…");
    await tc.setSource(makeSource(), { view: "keep" });
  }

  /** Coalesce bursts: a run of copies must not refetch once per clip. */
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => tc.refresh(), 250);
  }

  function onData(root) {
    renderLegend(root);
    scheduleInfo();
    const days = countDays(root);
    status(`${root.count.toLocaleString()} ${root.count === 1 ? "clip" : "clips"} · ${days} ${days === 1 ? "day" : "days"}`);

    el.empty.hidden = root.count > 0;
    if (!root.count) {
      el.empty.innerHTML = el.filter.value === "trash"
        ? "<b>Trash is empty</b>"
        : el.filter.value === "active"
          ? "<b>No clips here yet</b><div>Copy something — it lands on today automatically.</div>"
          : "<b>Nothing matches this filter</b>";
    }
  }

  function countDays(root) {
    let n = 0;
    for (const d of root.dayIndex.values()) if (d.count) n++;
    return n;
  }

  // ── Capture state ──────────────────────────────────────────────────────────
  async function loadCaptureState() {
    try {
      setCaptureUi(await api.capture.state());
    } catch (_) {
      el.capture.hidden = true; // an older main process without the channel
    }
  }

  /** { paused, error } from main: error means the clipboard cannot be read. */
  function setCaptureUi(s) {
    paused = !!(s && s.paused);
    const error = !paused && !!(s && s.error);
    el.capture.textContent = error ? "Capture error" : paused ? "Capture paused" : "Capturing";
    el.capture.classList.toggle("paused", paused);
    el.capture.classList.toggle("error", error);
    el.capture.title = error
      ? "ClipCanvas cannot read the clipboard right now. Tray menu → Open log file shows why."
      : paused
        ? "Nothing you copy is being saved. Click to resume."
        : "Everything you copy is saved. Click to pause.";
  }

  // ── Info panel ─────────────────────────────────────────────────────────────
  // Like the reference's side panel: where you are, and what is under the
  // cursor. Falls back to the selection, then to wherever the camera is.
  function scheduleInfo() {
    if (infoRaf != null) return;
    infoRaf = requestAnimationFrame(() => { infoRaf = null; renderInfo(); });
  }

  function renderInfo() {
    const node = hovered || selectedNode || tc.framed() || tc.getTree();
    const d = node ? tc.describe(node) : null;
    if (!d) { el.infoPath.textContent = ""; el.infoTitle.textContent = ""; return; }

    const path = d.path || [];
    el.infoPath.innerHTML = path.length
      ? path.map((p, i) => (i === path.length - 1 ? `<b>${esc(p)}</b>` : esc(p))).join(" › ")
      : "<b>Everything</b>";

    if (d.kind === "clip") {
      el.infoTitle.textContent = "";
      el.infoTitle.append(swatch(d.color), " " + d.title);
      const lines = [d.when];
      if (d.chars != null) {
        lines.push(`${d.chars.toLocaleString()} chars · ${d.lines.toLocaleString()} lines` +
                   (d.columns > 1 ? ` · ${d.columns} columns` : ""));
        lines.push(d.textScale >= 0.999
          ? "text at full size"
          : `text at ${(d.textScale * 100).toFixed(0)}% — readable from ${d.readableAt.toFixed(1)}× zoom`);
      } else {
        lines.push("image");
      }
      el.infoMeta.textContent = lines.join("\n");
      el.infoCats.innerHTML = "";
    } else {
      el.infoTitle.textContent = d.title || "All clips";
      el.infoMeta.textContent = d.count
        ? `${d.count.toLocaleString()} ${d.count === 1 ? "clip" : "clips"}` + (d.span ? `\n${d.span}` : "")
        : "nothing copied";
      el.infoCats.replaceChildren(...d.categories.slice(0, 6).map((c) =>
        h("div", "row", swatch(c.color), c.label, h("span", "n", String(c.count)))));
    }
  }

  function renderLegend(root) {
    const cats = root && root.cats ? root.cats : {};
    const byId = tc.categoryById;
    el.legend.replaceChildren(...Object.entries(cats)
      .filter(([id]) => byId[id])
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => h("span", "chip", swatch(byId[id].ink), byId[id].label + " ", h("span", "n", String(n)))));
    el.legend.hidden = !el.legend.children.length;
  }

  function onFrame(s) {
    if (!hovered && !selectedNode) scheduleInfo(); // the camera moved
    el.hud.textContent =
      `draw ${s.ms.toFixed(1)} ms · ${s.level} ${s.zoomLabel} · ${s.cards} cards · ` +
      `${s.loadedDays} days loaded (${s.loadedClips} clips) · ${s.textures} textures`;
  }

  // ── Selection / details ────────────────────────────────────────────────────
  async function onSelect(clip, node) {
    selected = clip;
    selectedNode = node || null;
    scheduleInfo();
    if (!clip) { el.details.hidden = true; return; }

    el.details.hidden = false;
    const d = node ? tc.describe(node) : null;
    el.dType.textContent = d ? d.category : clip.type;
    el.dType.style.color = d ? d.color : "";
    el.dType.style.borderColor = d ? d.color + "66" : "";
    el.dWhen.textContent = d ? d.when : "";
    el.dTitle.value = clip.title || "";

    el.dStar.classList.toggle("on", !!clip.is_starred);
    el.dPin.classList.toggle("on", !!clip.is_pinned);
    el.dArchive.classList.toggle("on", !!clip.is_archived);
    const trashed = !!clip.deleted_at;
    el.dDelete.hidden = trashed;
    el.dRestore.hidden = !trashed;

    const bytes = clip.file_size_bytes || (clip.content ? clip.content.length : 0);
    el.dMeta.textContent =
      `#${clip.id} · ${fmtBytes(bytes)} · ${clip.source || "clipboard"}` +
      (clip.tags && clip.tags.length ? " · " + clip.tags.join(", ") : "") +
      (trashed ? " · in Trash" : "");

    if (clip.type === "image" && clip.asset_path) {
      const img = document.createElement("img");
      img.alt = "clip " + clip.id;
      img.src = "clip-asset://" + String(clip.asset_path).replace(/\\/g, "/");
      el.dBody.replaceChildren(img);
    } else {
      let text = clip.content || "";
      if (clip.content_length && text.length < clip.content_length) {
        const full = await api.clips.content(clip.id);
        text = (full && full.content) || text;
      }
      const pre = document.createElement("pre");
      pre.textContent = text;
      el.dBody.replaceChildren(pre);
    }
  }

  async function patchSelected(patch) {
    if (!selected) return;
    const updated = await api.clips.update(selected.id, patch);
    Object.assign(selected, updated);
    onSelect(selected, selectedNode);
    refreshSoon();
  }

  function deselect() {
    tc.select(null);
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  // Runs as you type (fts5 prefix-matches the last word, see db.ftsQuery).
  // Enter opens the highlighted result; arrows move the highlight.
  function searchSoon() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 140);
  }

  async function runSearch() {
    const q = el.search.value.trim();
    const seq = ++searchSeq;
    if (!q) { closeResults(); return; }

    let found;
    try {
      found = await api.clips.search({
        query: q,
        workspaceId: Number(el.workspace.value) || undefined,
        boardId: Number(el.board.value) || undefined,
        includeArchived: true,
      });
    } catch (err) {
      found = [];
      console.error(err);
    }
    if (seq !== searchSeq) return; // a newer keystroke already answered

    hits = found;
    activeHit = hits.length ? 0 : -1;
    el.results.hidden = false;
    if (!hits.length) {
      el.results.innerHTML = '<div class="result none"><div class="r-body">No matches</div></div>';
      return;
    }
    el.results.innerHTML = hits.map((c, i) => `
      <button class="result${i === 0 ? " active" : ""}" data-i="${i}" tabindex="-1">
        <div class="r-head">
          <span class="pill">${esc(c.type)}</span>
          ${c.is_archived ? '<span class="pill">archived</span>' : ""}
          <span class="r-when">${whenText(c.created_at)}</span>
        </div>
        <div class="r-body">${esc(oneLine(c))}</div>
      </button>`).join("");
    for (const btn of el.results.querySelectorAll(".result[data-i]")) {
      btn.addEventListener("click", () => openHit(Number(btn.dataset.i)));
    }
  }

  function moveHit(delta) {
    if (!hits.length) return;
    activeHit = (activeHit + delta + hits.length) % hits.length;
    const btns = el.results.querySelectorAll(".result[data-i]");
    btns.forEach((b, i) => b.classList.toggle("active", i === activeHit));
    if (btns[activeHit]) btns[activeHit].scrollIntoView({ block: "nearest" });
  }

  /** Fly to a search hit -- loading its day, and widening the filter if it hides it. */
  async function openHit(i) {
    const hit = hits[i];
    if (!hit) return;
    closeResults();
    if (!matchesFilter(hit, el.filter.value)) {
      el.filter.value = "all";
      await resource();
    }
    await tc.reveal(hit);
  }

  function matchesFilter(c, f) {
    switch (f) {
      case "trash": return !!c.deleted_at;
      case "starred": return !c.deleted_at && !!c.is_starred;
      case "pinned": return !c.deleted_at && !!c.is_pinned;
      case "archived": return !c.deleted_at && !!c.is_archived;
      case "all": return !c.deleted_at;
      default: return !c.deleted_at && !c.is_archived;
    }
  }

  function closeResults() {
    el.results.hidden = true;
    hits = [];
    activeHit = -1;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function wireEvents() {
    el.workspace.addEventListener("change", async () => {
      await api.workspaces.setActive(Number(el.workspace.value));
      await loadBoards();
      await resource();
    });
    el.board.addEventListener("change", resource);
    el.filter.addEventListener("change", resource);
    el.reload.addEventListener("click", resource);
    el.fit.addEventListener("click", () => tc.fitAll(true));
    el.today.addEventListener("click", () => tc.showToday(true));
    el.settings.addEventListener("click", () => api.window.openSettings());

    el.capture.addEventListener("click", async () => {
      setCaptureUi(await api.capture.setPaused(!paused));
    });
    api.on("capture:changed", setCaptureUi);

    el.emptyTrash.addEventListener("click", emptyTrash);

    el.search.addEventListener("input", searchSoon);
    el.search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveHit(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveHit(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(searchTimer);
        if (hits.length) openHit(Math.max(0, activeHit));
        else runSearch();
      } else if (e.key === "Escape") {
        el.search.value = "";
        closeResults();
        el.search.blur();
      }
    });

    el.dClose.addEventListener("click", deselect);
    el.dTitle.addEventListener("change", () => patchSelected({ title: el.dTitle.value }));
    el.dStar.addEventListener("click", () => patchSelected({ is_starred: selected.is_starred ? 0 : 1 }));
    el.dPin.addEventListener("click", () => patchSelected({ is_pinned: selected.is_pinned ? 0 : 1 }));
    el.dArchive.addEventListener("click", () => patchSelected({ is_archived: selected.is_archived ? 0 : 1 }));

    el.dCopy.addEventListener("click", async () => {
      if (!selected) return;
      await api.clips.copyBack(selected.id);
      flash(el.dCopy, "Copied");
    });

    el.dDelete.addEventListener("click", async () => {
      if (!selected) return;
      await api.clips.remove([selected.id]);
      deselect();
      refreshSoon();
    });

    el.dRestore.addEventListener("click", async () => {
      if (!selected) return;
      await api.clips.restore([selected.id]);
      deselect();
      refreshSoon();
    });

    // A new capture lands on today. Only today's cell is refetched.
    api.on("clip:added", refreshSoon);

    // The controls hint sits over the canvas's top-left; show it for the first
    // moments only, and get out of the way on first interaction.
    const hint = $("hint");
    const dismiss = () => hint.classList.add("gone");
    setTimeout(dismiss, 7000);
    el.stage.addEventListener("pointerdown", dismiss, { once: true });
    el.stage.addEventListener("wheel", dismiss, { once: true, passive: true });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "Escape") {
        if (!el.results.hidden) { closeResults(); return; }
        if (!el.details.hidden) { deselect(); return; }
        if (!typing) api.window.hide();
        return;
      }
      if (!typing && e.key === "/") { e.preventDefault(); el.search.focus(); el.search.select(); }
      if (e.ctrlKey && e.key === ",") { e.preventDefault(); api.window.openSettings(); }
    });
  }

  async function emptyTrash() {
    const opts = { workspaceId: Number(el.workspace.value) || undefined };
    const t = await api.clips.trashSummary(opts);
    if (!t || !t.count) { flash(el.emptyTrash, "Trash is empty"); return; }
    const ok = window.confirm(
      `Permanently delete ${t.count.toLocaleString()} ${t.count === 1 ? "clip" : "clips"} ` +
      `(${fmtBytes(t.bytes)}) from Trash?\n\nThis cannot be undone.`
    );
    if (!ok) return;
    await api.clips.emptyTrash(opts);
    deselect();
    await tc.refresh();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  /** created_at is Unix SECONDS -- see the note at the top of db.js. */
  function whenText(ts) {
    const n = Number(ts) || 0;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return d.toLocaleString(undefined, {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  function oneLine(c) {
    if (c.type === "image") return c.title || "(image)";
    return (c.content || "").replace(/\s+/g, " ").trim().slice(0, 160) || "(empty)";
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
  }

  // Colours are set through CSSOM (element.style), never as style="..." in an
  // HTML string: the page's CSP is style-src 'self', which blocks inline style
  // attributes -- the legend and info-panel swatches rendered colourless until
  // this was changed. CSSOM writes are not affected by style-src.
  function swatch(color) {
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = color;
    return sw;
  }

  function h(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function status(t) { el.status.textContent = t; }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1100);
  }

  function fatal(err) {
    console.error(err);
    el.empty.hidden = false;
    el.empty.innerHTML = `<b>Could not start</b><div>${esc(err.message || err)}</div>`;
  }
})();
