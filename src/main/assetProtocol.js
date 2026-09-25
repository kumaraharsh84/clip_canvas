// ─── src/main/assetProtocol.js ───────────────────────────────────────────────
// clip-asset:// -- how the renderer reads stored images.
//
// Shared by main.js and scratch/verify-app.js so the verifier exercises the
// app's real handler rather than a copy of it that can drift.
//
// The renderer runs with contextIsolation and no node access; handing it raw
// file:// paths to the user's disk would widen that surface for no reason.
// This scheme resolves only inside the storage folder, and the containment
// check is what makes an asset_path of "../../.ssh/id_rsa" resolve to nothing.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");

const ASSET_SCHEME = "clip-asset";

/** Must run before app `ready`. */
function registerAssetScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { secure: true, supportFetchAPI: true, bypassCSP: false } },
  ]);
}

function handleAssetProtocol(protocol, storageDir) {
  const root = path.normalize(storageDir);
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, "");
    const full = path.normalize(path.join(root, rel));

    if (!full.startsWith(root)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const data = fs.readFileSync(full);
      return new Response(data, { headers: { "content-type": mimeFor(full) } });
    } catch (_) {
      return new Response("not found", { status: 404 });
    }
  });
}

function mimeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

module.exports = { ASSET_SCHEME, registerAssetScheme, handleAssetProtocol, mimeFor };
