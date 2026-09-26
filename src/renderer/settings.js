// ─── src/renderer/settings.js ────────────────────────────────────────────────
// The Settings window: the global shortcut, capture, start-up, storage, about.
//
// Everything is saved as it changes -- there is no Save button to forget.
// The window keeps no settings of its own: every change goes to main.js, and
// what comes back (or a settings:changed / capture:changed event, when the
// tray changes something) is what gets drawn.
//
// RECORDING A SHORTCUT
// Click the key caps, then press the combination. main.js suspends the current
// global shortcut meanwhile, or pressing it would toggle the canvas window
// instead of reaching this one. Esc or clicking away cancels. main.js checks
// the result (hotkey.js) and tries to register it; if another app owns it, the
// old shortcut stays and the reason is shown here.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let recording = false;
  let swallowKeyup = false;

  init().catch((err) => message(String(err && err.message ? err.message : err), "error"));

  async function init() {
    wire();
    render(await api.settings.get());
    api.on("settings:changed", render);
    api.on("capture:changed", (capture) => {
      if (!state) return;
      state.capture = capture;
      renderCapture();
    });
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  function render(s) {
    state = s;
    renderHotkey();
    renderCapture();
    $("autostart").checked = !!s.autoStart;

    const st = s.stats;
    $("stats").textContent =
      `${st.clips.toLocaleString()} ${st.clips === 1 ? "clip" : "clips"}` +
      ` · ${st.images.toLocaleString()} ${st.images === 1 ? "image" : "images"} (${bytes(st.imageBytes)})` +
      ` · database ${bytes(st.dbBytes)}`;
    $("storage-path").textContent = s.storageDir || "";
    $("log-path").textContent = s.logFile || "not available";
    $("open-log").disabled = !s.logFile;

    $("version").textContent = s.version;
    $("versions").textContent =
      `Electron ${s.versions.electron} · Chromium ${s.versions.chrome} · Node ${s.versions.node}` +
      (s.dev ? " · development run" : "");
    $("open-home").hidden = !s.homepage;
  }

  function renderHotkey() {
    if (!recording) {
      $("hotkey").replaceChildren(...(state.hotkey ? keycaps(state.hotkey) : [el("span", "none", "No shortcut")]));
      // Why the shortcut is not the one expected -- or that there is none.
      if (state.hotkeyNote) message(state.hotkeyNote, state.hotkey ? "warn" : "error");
    }
    const reset = $("hotkey-reset");
    reset.hidden = !state.hotkeySaved;
    reset.textContent = "Use the default, " + display(state.hotkeyDefault);
  }

  function renderCapture() {
    const c = state.capture || {};
    $("capture").checked = !c.paused;
    $("capture-error").hidden = !c.error || c.paused;
  }

  /** "Ctrl+Alt+Space" as key caps: <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + ... */
  function keycaps(accelerator) {
    const out = [];
    display(accelerator).split(" + ").filter(Boolean).forEach((k, i) => {
      if (i) out.push(el("span", "plus", "+"));
      out.push(el("kbd", null, k));
    });
    return out;
  }

  // ── Recording a shortcut ───────────────────────────────────────────────────
  async function startRecording() {
    if (recording) return;
    recording = true;
    await api.settings.suspendHotkey(true);
    const b = $("hotkey");
    b.classList.add("recording");
    b.textContent = "Press the new shortcut…";
    message("Hold Ctrl, Alt or Win and press a key. Esc cancels.", "");
  }

  async function finishRecording(accelerator) {
    if (!recording) return;
    recording = false;
    $("hotkey").classList.remove("recording");
    $("hotkey").blur();
    if (!accelerator) {
      await api.settings.suspendHotkey(false);
      message("", "");
      renderHotkey();
      return;
    }
    // main.js brings the old shortcut back if this one is refused.
    const r = await api.settings.setHotkey(accelerator);
    render(r.state);
    if (!r.ok) message(r.error, "error");
    else if (r.warning) message("Saved. " + r.warning, "warn");
    else message(`Saved. ${display(r.hotkey)} now opens ClipCanvas.`, "ok");
  }

  function onKey(e) {
    if (!recording) {
      if (e.key === "Escape") window.close();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Releasing Space or Enter would "click" the focused key-cap button and
    // start a new recording straight away.
    swallowKeyup = true;
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (e.key === "Escape" && plain) { finishRecording(null); return; }

    const key = keyName(e.code);
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
    if (!key) {
      // Only modifiers so far: show what is held.
      $("hotkey").replaceChildren(...keycaps(mods.join("+")), el("span", "plus", mods.length ? "+ …" : "…"));
      return;
    }
    finishRecording(mods.concat(key).join("+"));
  }

  /** A KeyboardEvent.code as an Electron accelerator key, or null for modifiers. */
  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return {
      Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
      Enter: "Enter", NumpadEnter: "Enter", Escape: "Esc",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";",
      Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`", Backslash: "\\",
    }[code] || null;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  function wire() {
    $("hotkey").addEventListener("click", startRecording);
    // Clicking elsewhere, or leaving the window, cancels a recording.
    $("hotkey").addEventListener("blur", () => finishRecording(null));
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", (e) => {
      if (!swallowKeyup) return;
      e.preventDefault();
      if (!recording) swallowKeyup = false;
    }, true);

    $("hotkey-reset").addEventListener("click", async () => {
      message("", "");
      const r = await api.settings.resetHotkey();
      render(r.state);
      if (r.ok && !r.state.hotkeyNote) message(`Saved. ${display(r.hotkey)} now opens ClipCanvas.`, "ok");
    });

    $("capture").addEventListener("change", async (e) => {
      state.capture = await api.capture.setPaused(!e.target.checked);
      renderCapture();
    });
    $("autostart").addEventListener("change", async (e) => {
      render(await api.settings.setAutoStart(e.target.checked));
    });

    $("open-storage").addEventListener("click", () => api.storage.openFolder());
    $("open-log").addEventListener("click", () => api.app.openLog());
    $("capture-log").addEventListener("click", () => api.app.openLog());
    $("open-home").addEventListener("click", () => api.app.openHomepage());
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function message(text, kind) {
    const m = $("hotkey-msg");
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }

  /** Same wording as src/main/hotkey.js display(): Super is shown as Win. */
  function display(accelerator) {
    return String(accelerator || "").split("+").filter(Boolean)
      .map((p) => (p === "Super" ? "Win" : p)).join(" + ");
  }

  function bytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
})();
