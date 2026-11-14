// Tiny static server for the Time Canvas demo.  node demo/serve.js
// Serves this folder, plus the one file the demo borrows from the app: the
// canvas bundle (the page asks for ../src/renderer/timecanvas.bundle.js).
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = __dirname, PORT = Number(process.env.PORT || 8790);
const BUNDLE_URL = "src/renderer/timecanvas.bundle.js";
const BUNDLE = path.join(ROOT, "..", "src", "renderer", "timecanvas.bundle.js");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css", ".json": "application/json" };
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = rel === BUNDLE_URL ? BUNDLE : path.join(ROOT, rel);
  const inside = file === BUNDLE || file.startsWith(ROOT + path.sep);
  if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log("Time Canvas demo -> http://localhost:" + PORT));
