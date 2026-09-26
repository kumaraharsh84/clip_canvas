// ─── tools/build-icons.js ────────────────────────────────────────────────────
// Renders the app icon from its SVG sources:
//
//   src/assets/logo.svg        the logo (40 px and up)
//   src/assets/logo-small.svg  the same, simplified for 16-32 px
//
// into
//
//   src/assets/icon.ico   every size Windows asks for (tray, title bar,
//                         taskbar, Explorer, installer), PNG-compressed
//   src/assets/icon.png   256 px, the fallback main.js uses
//
// Each size is rendered by Chromium straight from the vector at that size --
// not scaled down from a large bitmap -- so small icons stay sharp.
//
// Usage:  npm run icons  [-- --preview=FILE]
//         --preview writes a sheet of every size on dark and light, to check.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "src", "assets");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const SMALL_MAX = 32; // up to here, logo-small.svg

const argv = process.argv.slice(2);
const previewArg = argv.find((a) => a.startsWith("--preview="));
const PREVIEW = previewArg ? path.resolve(previewArg.split("=")[1]) : null;

/** SVG source sized to `size` px, as a data URL. */
function svgAt(file, size) {
  const src = fs.readFileSync(path.join(ASSETS, file), "utf8")
    .replace("<svg ", `<svg width="${size}" height="${size}" `);
  return "data:image/svg+xml;base64," + Buffer.from(src).toString("base64");
}

/** Render a data-URL image to a PNG of `size` px, in the page. */
function renderJs(url, size) {
  return `(async () => {
    const img = new Image(${size}, ${size});
    img.src = ${JSON.stringify(url)};
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = ${size};
    c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL("image/png");
  })()`;
}

/**
 * An .ico holding PNG images (Windows Vista and later read these):
 * a 6-byte header, a 16-byte entry per image, then the PNGs.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);  // palette size
    e.writeUInt8(0, 3);  // reserved
    e.writeUInt16LE(1, 4);  // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("about:blank");

    const images = [];
    for (const size of SIZES) {
      const file = size <= SMALL_MAX ? "logo-small.svg" : "logo.svg";
      const dataUrl = await win.webContents.executeJavaScript(renderJs(svgAt(file, size), size), true);
      images.push({ size, png: Buffer.from(dataUrl.split(",")[1], "base64"), dataUrl });
    }

    fs.writeFileSync(path.join(ASSETS, "icon.ico"), ico(images));
    fs.writeFileSync(path.join(ASSETS, "icon.png"), images.find((i) => i.size === 256).png);
    console.log(`wrote src/assets/icon.ico (${SIZES.join(", ")} px) and src/assets/icon.png (256 px)`);

    if (PREVIEW) {
      // Every size at 1:1, on a dark and a light strip (both taskbar themes),
      // then the small sizes enlarged 4x without smoothing, pixel by pixel.
      const sheet = await win.webContents.executeJavaScript(`(async () => {
        const imgs = ${JSON.stringify(images.map((i) => ({ size: i.size, url: i.dataUrl })))};
        const W = 820, H = 470;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#1f1f1f"; ctx.fillRect(0, 0, W, 290);
        ctx.fillStyle = "#f3f3f3"; ctx.fillRect(0, 290, W, 60);
        ctx.fillStyle = "#2b2b2b"; ctx.fillRect(0, 350, W, H - 350);
        const loaded = await Promise.all(imgs.map(async (i) => {
          const im = new Image(); im.src = i.url; await im.decode(); return { ...i, im };
        }));
        let x = 12;
        for (const i of loaded) {
          ctx.drawImage(i.im, x, 280 - i.size);
          ctx.drawImage(i.im, x, 290 + (60 - Math.min(i.size, 48)) / 2, Math.min(i.size, 48), Math.min(i.size, 48));
          x += i.size + 14;
        }
        ctx.imageSmoothingEnabled = false;
        x = 12;
        for (const i of loaded.filter((i) => i.size <= 32)) {
          ctx.drawImage(i.im, x, 362, i.size * 3, i.size * 3);
          x += i.size * 3 + 16;
        }
        return c.toDataURL("image/png");
      })()`, true);
      fs.writeFileSync(PREVIEW, Buffer.from(sheet.split(",")[1], "base64"));
      console.log("wrote preview " + PREVIEW);
    }
  } catch (err) {
    // A failed image decode rejects with an Event, not an Error.
    console.error("[icons] " + (err && err.stack ? err.stack : err && err.type ? "image failed to " + err.type + " -- is the SVG valid XML?" : err));
    code = 1;
  }
  app.exit(code);
});
