// ─── test/verify-asset-protocol.js ───────────────────────────────────────────
// Checks for src/main/assetProtocol.js, the clip-asset:// handler through
// which the window reads stored images: it serves files inside the storage
// folder, with the headers the canvas's fetch() needs, and nothing outside it
// -- however the path is spelled.
//
// Plain Node: the handler is registered on a stand-in for Electron's protocol
// module and called with real Request objects.
//
// Usage:  node test/verify-asset-protocol.js
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");
const { handleAssetProtocol } = require(path.join(__dirname, "..", "src", "main", "assetProtocol.js"));

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clipcanvas-verify-assets-"));
const storage = path.join(TMP, "storage");
fs.mkdirSync(path.join(storage, "images", "2026", "09"), { recursive: true });
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
fs.writeFileSync(path.join(storage, "images", "2026", "09", "img-a.png"), PNG);
// A file right beside the storage folder -- what an escape would reach.
fs.writeFileSync(path.join(TMP, "secret.txt"), "not for the window");
// And in a sibling folder whose name merely STARTS like the storage folder's.
fs.mkdirSync(path.join(TMP, "storage-evil"));
fs.writeFileSync(path.join(TMP, "storage-evil", "secret.txt"), "not for the window");

let handler = null;
handleAssetProtocol({ handle: (scheme, fn) => { handler = fn; } }, storage);

async function get(url) {
  const res = await handler(new Request(url));
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), cors: res.headers.get("access-control-allow-origin"), body };
}

(async () => {
  console.log("\n-- serving stored images --");
  const a = await get("clip-asset://images/2026/09/img-a.png");
  ok("an image in storage is served", a.status === 200 && a.body.equals(PNG), `status ${a.status}`);
  ok("with its content type", a.type === "image/png", a.type);
  ok("with the CORS header the canvas's fetch() needs", a.cors === "*", String(a.cors));
  const missing = await get("clip-asset://images/2026/09/nope.png");
  ok("a missing image is a 404", missing.status === 404);

  console.log("\n-- nothing outside storage --");
  const attempts = [
    "clip-asset://images/../../secret.txt",
    "clip-asset://images/..%2f..%2fsecret.txt",
    "clip-asset://images/%2e%2e/%2e%2e/secret.txt",
    "clip-asset://..%2fsecret.txt",
    "clip-asset://images/..%5c..%5csecret.txt",
    "clip-asset://images/..%2f..%2fstorage-evil%2fsecret.txt",
  ];
  let leaked = 0;
  const statuses = [];
  for (const url of attempts) {
    const r = await get(url);
    statuses.push(r.status);
    if (r.status === 200 || r.body.toString().includes("not for the window")) leaked++;
  }
  ok("path tricks never reach a file outside the storage folder", leaked === 0,
     `${attempts.length} attempts -> ${statuses.join(", ")}`);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
