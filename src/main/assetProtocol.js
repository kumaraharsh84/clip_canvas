// ─── src/main/assetProtocol.js ───────────────────────────────────────────────
// clip-asset:// -- how the renderer reads stored images.
//
// Shared by main.js and test/verify-app.js so the verifier exercises the
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

/**
 * Must run before app `ready`.
 *
 * The canvas fetch()es thumbnails from a file:// page, which is a cross-origin
 * request; since Electron ~35 Chromium refuses those for any scheme not
 * registered as standard and CORS-enabled ("Cross origin requests are only
 * supported for protocol schemes: ... http, https"). Responses carry
 * Access-Control-Allow-Origin for the same reason. The scheme exists only
 * inside this app, and the handler still serves nothing outside storageDir.
 */
function registerAssetScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false },
    },
  ]);
}

const CORS = { "access-control-allow-origin": "*" };

function handleAssetProtocol(protocol, storageDir) {
  const root = path.resolve(storageDir);
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, "");
    const full = path.resolve(root, rel);

    // Inside root means a relative path that does not climb out. A prefix test
    // (full.startsWith(root)) also let through a SIBLING folder whose name
    // starts the same way: storage-old/ next to storage/.
    const inside = path.relative(root, full);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      return new Response("forbidden", { status: 403, headers: CORS });
    }
    try {
      const data = fs.readFileSync(full);
      return new Response(data, { headers: { ...CORS, "content-type": mimeFor(full) } });
    } catch (_) {
      return new Response("not found", { status: 404, headers: CORS });
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
