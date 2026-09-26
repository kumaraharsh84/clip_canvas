// ─── test/capture-demo.js ─────────────────────────────────────────────────
// Screenshots of the demo page for the README: the whole year, one month, one
// day, one hour, and one clip up close.
//
// The demo draws SYNTHETIC clips (demo/mockdata.js), so these images are safe
// to publish -- unlike verify-app.js --shots, which photographs your real
// clipboard history.
//
// Usage:
//   npx electron test/capture-demo.js [--out=docs] [--clips=2000]
//
// --clips must be one of the demo's own sizes: 500, 2000, 10000 or 40000.
//
// Renders OFFSCREEN for the same reason verify-app.js does: a hidden normal
// window stops producing compositor frames, and capturePage then returns a
// stale one.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

// The demo is a local page with no CSP; Electron's development-time warning
// about that is not something this script should report.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const OUT = path.resolve(flag("out", path.join(__dirname, "..", "docs")));
const CLIPS = flag("clips", "2000");
const WIDTH = Number(flag("width", 1400));
const HEIGHT = Number(flag("height", 860));

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Wait for the canvas, then keep drawing until textures and thumbnails stop
// arriving -- both are painted over several frames, within a per-frame budget.
const SETTLE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let w = 0; w < 20000 && !(window.__tc && window.__tc.getTree().count); w += 100) await sleep(100);
  const tc = window.__tc;
  if (!tc || !tc.getTree().count) return { error: "the demo never mounted" };
  await tc.whenIdle();
  let quiet = 0, last = "";
  for (let w = 0; w < 10000 && quiet < 4; w += 150) {
    tc.invalidate();
    await sleep(150);
    const s = tc.stats();
    const f = s.frame || {};
    const sig = [s.textures.made, s.images.entries, s.images.pending, f.thumbPending].join("/");
    quiet = sig === last ? quiet + 1 : 0;
    last = sig;
  }
  return { ok: true };
})()`;

const SET_COUNT = (n) => `(() => {
  const sel = document.getElementById("count");
  if (![...sel.options].some((o) => o.value === ${JSON.stringify(n)})) return { error: "no such size: ${n}" };
  if (sel.value !== ${JSON.stringify(n)}) { sel.value = ${JSON.stringify(n)}; sel.onchange(); }
  return { ok: true };
})()`;

// The busiest month, as a wall calendar.
const MONTH = `(() => {
  const tc = window.__tc;
  let best = null;
  for (const y of tc.getTree().children) for (const m of y.children) if (!best || m.count > best.count) best = m;
  document.getElementById("hint").hidden = true;
  tc.viewport.fitTo({ x0: best.x, y0: best.y, x1: best.x + best.w, y1: best.y + best.h }, 12);
  tc.invalidate();
  return { label: best.labelLong };
})()`;

/** Frame the best-scoring LOADED box at `depth` (2 day, 3 hour, 4 clip). */
const FRAME = (depth, score, pad) => `(() => {
  const tc = window.__tc;
  const score = ${score};
  let best = null, bs = -Infinity;
  (function walk(n) {
    if (n.depth === ${depth}) {
      if (n.depth === 2 && !n.children.length) return;
      const s = score(n);
      if (s > bs) { bs = s; best = n; }
      return;
    }
    (n.children || []).forEach(walk);
  })(tc.getTree());
  if (!best) return { error: "nothing at depth ${depth}" };
  // The controls hint sits over the top-left box labels once zoomed in.
  document.getElementById("hint").hidden = true;
  tc.viewport.fitTo({ x0: best.x, y0: best.y, x1: best.x + best.w, y1: best.y + best.h }, ${pad});
  tc.invalidate();
  return { label: best.labelLong || best.label || "" };
})()`;

// A day with many active hours; an hour with an image and a mix of kinds, but
// not so many clips that each is tiny; a medium code clip, read up close.
const DAY = `(n) => n.children.length * 100 + n.children.reduce((a, h) => a + h.children.length, 0)`;
const HOUR = `(n) => {
  const imgs = n.children.filter((c) => c.clip && c.clip.type === "image").length;
  const kinds = new Set(n.children.map((c) => c.cat && c.cat.id)).size;
  return (imgs ? 10 : 0) + kinds * 3 + Math.min(12, n.children.length) - Math.max(0, n.children.length - 14) * 2;
}`;
const CLIP = `(n) => {
  const c = n.clip;
  const len = c && c.content ? c.content.length : 0;
  return c && c.type === "code" && len > 500 && len < 1600 ? 1 : 0;
}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const errors = [];
  // Errors only. Electron 35+ puts level and message on the event.
  win.webContents.on("console-message", (e, ...old) => {
    const level = e.level !== undefined ? e.level : old[0];
    const message = e.message !== undefined ? e.message : old[1];
    if (level === "error" || level === 3) errors.push(message);
  });

  await win.loadFile(path.join(__dirname, "..", "demo", "index.html"));
  const run = async (js) => {
    const r = await win.webContents.executeJavaScript(js, true);
    if (r && r.error) throw new Error(r.error);
    return r;
  };
  const shot = async (name, label) => {
    await run(SETTLE);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, name + ".png");
    fs.writeFileSync(file, img.toPNG());
    const { width, height } = img.getSize();
    console.log(`wrote ${path.relative(process.cwd(), file)}  ${width}x${height}` +
                `  ${(fs.statSync(file).size / 1024).toFixed(0)} KB${label ? "  " + label : ""}`);
  };

  let failed = false;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await run(SETTLE);
    await run(SET_COUNT(CLIPS));
    await shot("overview", `${CLIPS} clips`);
    await shot("month", (await run(MONTH)).label);
    await shot("day", (await run(FRAME(2, DAY, 14))).label);
    await shot("hour", (await run(FRAME(3, HOUR, 12))).label);
    await shot("clip", (await run(FRAME(4, CLIP, 18))).label);
  } catch (err) {
    failed = true;
    console.error("[capture] " + err.message);
  }
  if (errors.length) {
    failed = true;
    console.error("[capture] console errors:\n  " + errors.slice(0, 5).join("\n  "));
  }
  app.exit(failed ? 1 : 0);
});
