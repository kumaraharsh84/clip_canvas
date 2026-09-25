// ─── src/renderer/renderer.js ────────────────────────────────────────────────
// UI shell around the Time Canvas.
//
// This process has no require and no filesystem (contextIsolation is on), so
// everything goes through window.api from preload.js, and the canvas engine
// arrives as timecanvas.bundle.js -- rebuild it with
//   node src/renderer/canvas/build.js src/renderer/timecanvas.bundle.js
// after editing anything under src/renderer/canvas/.
//
// Navigation keys (F, +/-, arrows, Backspace) belong to the canvas controls.
// This file only handles app-level keys: "/" to search and Escape to close.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const { mountTimeCanvas, mountTimelineStrip } = window.ClipCanvasTimeCanvas;
  const api = window.api;

  const $ = (id) => document.getElementById(id);
  const el = {
    workspace: $("workspace"), board: $("board"), filter: $("filter"),
    search: $("search"), fit: $("fit"), reload: $("reload"), status: $("status"),
    stage: $("time-container"), hud: $("hud"), details: $("details"),
    results: $("results"), empty: $("empty"), legend: $("legend"), timeline: $("timeline"),
    infoPath: $("info-path"), infoTitle: $("info-title"),
    infoMeta: $("info-meta"), infoCats: $("info-cats"),
    dType: $("d-type"), dWhen: $("d-when"), dTitle: $("d-title"),
    dBody: $("d-bodywrap"), dMeta: $("d-meta"), dClose: $("d-close"),
    dCopy: $("d-copy"), dStar: $("d-star"), dPin: $("d-pin"),
    dArchive: $("d-archive"), dDelete: $("d-delete"),
  };

  let tc = null;
  let strip = null;
  let selectedNode = null;
  let clips = [];
  let reloadTimer = null;
  let infoRaf = null;
  let hovered = null;

  init().catch(fatal);

  async function init() {
    tc = mountTimeCanvas(el.stage, {
      onFrame,
      onHover: (node) => { hovered = node; scheduleInfo(); },
      // Assets are served by the clip-asset:// handler registered in main.js,
      // which resolves only inside the storage folder.
      resolveImage: (clip) =>
        clip.asset_path
          ? "clip-asset://" + String(clip.asset_path).replace(/\\/g, "/")
          : clip.content,
    });
    strip = mountTimelineStrip(el.timeline, tc);

    // Handle for the headless harnesses in scratch/ to drive the camera and
    // read layout state. Deliberately the only global this file creates.
    window.__tc = tc;

    await loadWorkspaces();
    await reload();
    wireEvents();
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function loadWorkspaces() {
    const ws = await api.workspaces.list();
    el.workspace.innerHTML = ws
      .map((w) => `<option value="${w.id}">${esc(w.name)} (${w.clip_count})</option>`)
      .join("");

    const active = ws.find((w) => w.clip_count > 0) || ws[0];
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

  async function reload({ keepView = false } = {}) {
    status("loading…");
    const t0 = performance.now();

    // Full rows, not summaries: every card holds its ENTIRE text, so the layout
    // needs the whole body to count lines. getClipSummaries cuts content at 4 KB.
    clips = await api.invoke("clips:getAll", {
      workspaceId: Number(el.workspace.value) || undefined,
      boardId: Number(el.board.value) || undefined,
      filter: el.filter.value,
      max: 20000,
    });

    const fetchMs = performance.now() - t0;
    const t1 = performance.now();
    tc.setClips(clips, { keepView });
    const layoutMs = performance.now() - t1;

    el.empty.hidden = clips.length > 0;
    if (!clips.length) {
      el.empty.innerHTML =
        "<b>No clips here yet</b><div>Copy something — it lands on the timeline automatically.</div>";
    }

    renderLegend();
    scheduleInfo();
    status(`${clips.length.toLocaleString()} clips · fetch ${fetchMs | 0}ms · layout ${layoutMs | 0}ms`);
  }

  /** Coalesce bursts: pasting a run of clips must not relayout once per clip. */
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload({ keepView: true }), 400);
  }

  // ── Info panel ─────────────────────────────────────────────────────────────
  // Like the reference's side panel: where you are, and what is under the
  // cursor. Falls back to the selection, then to the whole archive.
  function scheduleInfo() {
    if (infoRaf != null) return;
    infoRaf = requestAnimationFrame(() => { infoRaf = null; renderInfo(); });
  }

  function renderInfo() {
    // Under the cursor first, then the selection, then wherever the camera is.
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
      el.infoMeta.textContent =
        `${d.count.toLocaleString()} ${d.count === 1 ? "clip" : "clips"}` + (d.span ? `\n${d.span}` : "");
      el.infoCats.replaceChildren(...d.categories.slice(0, 6).map((c) =>
        h("div", "row", swatch(c.color), c.label, h("span", "n", String(c.count)))));
    }
  }

  function renderLegend() {
    const root = tc.getTree();
    const cats = root && root.cats ? root.cats : {};
    const byId = tc.categoryById;
    el.legend.replaceChildren(...Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => h("span", "chip", swatch(byId[id].ink), byId[id].label + " ", h("span", "n", String(n)))));

    el.legend.hidden = !Object.keys(cats).length;
  }

  function onFrame(s) {
    if (!hovered && !selectedNode) scheduleInfo(); // the camera moved
    el.hud.textContent =
      `draw ${s.ms.toFixed(1)} ms · ${s.level} ${s.zoomLabel} · ${s.cards} cards · ` +
      `${s.textures} textures · lines ${s.linesDrawn}/${s.linesTotal}`;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function wireEvents() {
    el.workspace.addEventListener("change", async () => {
      await api.workspaces.setActive(Number(el.workspace.value));
      await loadBoards();
      await reload();
    });
    el.board.addEventListener("change", () => reload());
    el.filter.addEventListener("change", () => reload());
    el.reload.addEventListener("click", () => reload({ keepView: true }));
    el.fit.addEventListener("click", () => tc.fitAll(true));

    // A new capture appears without being asked for, where it belongs in time.
    api.on("clip:added", scheduleReload);

    // The controls hint sits over the canvas's top-left labels; show it for
    // the first moments only, and get out of the way on first interaction.
    const hint = $("hint");
    const dismiss = () => hint.classList.add("gone");
    setTimeout(dismiss, 7000);
    el.stage.addEventListener("pointerdown", dismiss, { once: true });
    el.stage.addEventListener("wheel", dismiss, { once: true, passive: true });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "Escape") {
        if (!typing) api.window.hide();
        return;
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  function fatal(err) {
    console.error(err);
    el.empty.hidden = false;
    el.empty.innerHTML = `<b>Could not start</b><div>${esc(err.message || err)}</div>`;
  }
})();
