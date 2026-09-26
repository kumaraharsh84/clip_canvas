// ─── tools/record-gif.js ─────────────────────────────────────────────────────
// Records docs/zoom.gif for the README: the demo's synthetic history, flown
// through from a whole year down to one readable clip, and back out.
//
// The demo draws SYNTHETIC clips (demo/mockdata.js); never point this at the
// app, whose canvas is your real clipboard history.
//
// Frames are rendered, not filmed: for each one the camera is placed exactly
// where the app's own fly-to animation (controls.js animateTo -- ease-in-out
// cubic, scale in log space, centre interpolated) would have it, the canvas is
// redrawn until every card's texture is painted, and the page is captured.
// So the GIF is smooth whatever this machine's frame rate, and shows the real
// motion. Pauses are one frame with a long delay, not repeated frames.
//
// Usage:  npm run gif  [-- --out=docs/zoom.gif --width=640 --stills=DIR]
//         --stills also saves each stop (year, month, day, hour, clip) as PNG.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const OUT = path.resolve(flag("out", path.join(__dirname, "..", "docs", "zoom.gif")));
const WIDTH = Number(flag("width", 640));   // GIF width in pixels
const STILLS = flag("stills", null);
const VIEW = { width: 1200, height: 750 };   // page size in CSS pixels (the year view needs
                                             // day cells big enough to show their clips)
const FPS = 15;
const LEG_FRAMES = 13;                       // frames per fly-in
const RETURN_FRAMES = 16;                    // frames for the final fly-out

// Keyframes, found in the page: the year, its busiest month and that month's
// busiest day (from counts -- nothing need be loaded yet) ...
const FIND_DAY = `(() => { try {
  const root = window.__tc.getTree();
  const box = (n) => ({ x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h });
  const years = root.children.filter((y) => y.count > 0);
  const year = years[years.length - 1];
  const month = year.children.reduce((a, b) => (b.count > a.count ? b : a));
  const day = month.children.reduce((a, b) => (b.count > a.count ? b : a));
  return { year: box(year), month: box(month), day: box(day), t: day.time,
           labels: [year.labelLong, month.labelLong, day.labelLong] };
} catch (err) { return { error: String(err && err.stack || err) }; } })()`;

// ... then, once the camera is on that day and it has loaded, an hour with a
// mix of kinds and a medium code clip in it.
const FIND_CLIP = (t) => `(() => { try {
  const day = window.__tc.dayNode(${t.year}, ${t.month}, ${t.day});
  const box = (n) => ({ x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h });
  const score = (h) => new Set(h.children.map((c) => c.cat.id)).size * 3 + Math.min(10, h.children.length)
                       - Math.max(0, h.children.length - 12) * 2;
  const hour = day.children.reduce((a, b) => (score(b) > score(a) ? b : a));
  const clip = hour.children.find((c) => c.clip.type === "code" && c.clip.content.length > 300 && c.clip.content.length < 1500)
            || hour.children.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  return { hour: box(hour), clip: box(clip), labels: [hour.labelLong, clip.cat.label] };
} catch (err) { return { error: String(err && err.stack || err) }; } })()`;

/** The viewport that fits a box, as viewport.fitTo computes it. */
const FIT = (b, pad) => `(() => {
  const vp = window.__tc.viewport;
  const s = vp.snapshot();
  vp.fitTo(${JSON.stringify(b)}, ${pad});
  const t = vp.snapshot();
  vp.restore(s);
  return t;
})()`;

/** Put the camera at a state and wait until the frame is fully painted. */
const SHOW = (st) => `(async () => {
  const tc = window.__tc, vp = tc.viewport;
  vp.scale = ${st.scale}; vp.x = ${st.x}; vp.y = ${st.y};
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < 40; i++) {
    tc.invalidate();
    await raf(); await raf();
    const f = tc.stats().frame;
    const img = tc.images.stats();
    if (f && !f.needsMore && img.pending === 0 && img.queued === 0) break;
  }
  await tc.whenIdle();
  return true;
})()`;

/** controls.animateTo's path: eased t, scale in log space, centre linear. */
function between(a, b, t, w, h) {
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * e);
  const acx = a.x + w / (2 * a.scale), acy = a.y + h / (2 * a.scale);
  const bcx = b.x + w / (2 * b.scale), bcy = b.y + h / (2 * b.scale);
  const cx = acx + (bcx - acx) * e, cy = acy + (bcy - acy) * e;
  return { scale, x: cx - w / (2 * scale), y: cy - h / (2 * scale) };
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({
      width: VIEW.width, height: VIEW.height, show: false, useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(60);
    await win.loadFile(path.join(__dirname, "..", "demo", "index.html"));
    const run = (js) => win.webContents.executeJavaScript(js, true);

    // No developer toolbar, hint or frame stats in the film.
    await win.webContents.insertCSS(
      "header, #hint, #hud { display: none !important; } body { grid-template-rows: 1fr !important; }");
    for (let w = 0; w < 30000; w += 200) {
      if (await run("!!(window.__tc && window.__tc.getTree().count)")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await run("(async () => { window.__tc.fitAll(false); await window.__tc.whenIdle(); })()");

    const k = await run(FIND_DAY);
    if (k.error) throw new Error("finding the day: " + k.error);
    const vp = await run("({ w: window.__tc.viewport.width, h: window.__tc.viewport.height })");
    const stops = [await run(FIT(k.year, 20)), await run(FIT(k.month, 16)), await run(FIT(k.day, 14))];
    await run(SHOW(stops[2]));          // fly there once, so the day loads
    const c = await run(FIND_CLIP(k.t));
    if (c.error) throw new Error("finding the clip: " + c.error);
    stops.push(await run(FIT(c.hour, 12)), await run(FIT(c.clip, 18)));
    console.log("path: " + k.labels.concat(c.labels).join(" > "));

    // The film: [camera state, how long it stays on screen in ms].
    const frameMs = Math.round(1000 / FPS);
    const holds = [1100, 700, 700, 700, 1600];
    const shots = [];
    for (let i = 0; i < stops.length; i++) {
      if (i > 0) {
        for (let f = 1; f < LEG_FRAMES; f++) shots.push([between(stops[i - 1], stops[i], f / LEG_FRAMES, vp.w, vp.h), frameMs]);
      }
      shots.push([stops[i], holds[i], i]);
    }
    for (let f = 1; f < RETURN_FRAMES; f++) {
      shots.push([between(stops[stops.length - 1], stops[0], f / RETURN_FRAMES, vp.w, vp.h), frameMs]);
    }

    const gif = GIFEncoder();
    let height = 0;
    for (let i = 0; i < shots.length; i++) {
      const [st, delay, stop] = shots[i];
      await run(SHOW(st));
      await new Promise((r) => setTimeout(r, 30));
      const img = (await win.webContents.capturePage()).resize({ width: WIDTH, quality: "best" });
      const { width, height: h } = img.getSize();
      if (STILLS && stop !== undefined) {
        fs.mkdirSync(STILLS, { recursive: true });
        fs.writeFileSync(path.join(STILLS, `stop-${stop}.png`), img.toPNG());
      }
      height = h;
      // toBitmap is BGRA on Windows; the encoder wants RGBA.
      const px = new Uint8Array(img.toBitmap());
      for (let p = 0; p < px.length; p += 4) { const b = px[p]; px[p] = px[p + 2]; px[p + 2] = b; px[p + 3] = 255; }
      const palette = quantize(px, 256, { format: "rgb565" });
      gif.writeFrame(applyPalette(px, palette, "rgb565"), width, h, { palette, delay, repeat: 0 });
      if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${shots.length} frames\n`);
    }
    gif.finish();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, gif.bytes());
    const secs = shots.reduce((a, s) => a + s[1], 0) / 1000;
    console.log(`wrote ${path.relative(process.cwd(), OUT)}  ${WIDTH}x${height}  ${shots.length} frames  ` +
                `${secs.toFixed(1)} s  ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
  } catch (err) {
    console.error("[gif] " + (err && err.stack ? err.stack : String(err)));
    code = 1;
  }
  app.exit(code);
});
