// Experiment: the paths of files copied in Explorer, three ways. Copy a file
// or two in Explorer, then run this. It is the starting point for capturing
// copied files, which ClipCanvas does not do yet.
//
//   npx electron test/diagnostics/test_clipboard_files.js
const { app, clipboard } = require("electron");
const { execSync } = require("child_process");

const osFormat = (name) => `electron application/osclipboard;format="${name}"`;

/** The bytes of one type on the clipboard, or null when it is not there. */
async function bytesOf(items, type) {
  for (const item of items) {
    const found = item.types.find((t) => t.toLowerCase() === type.toLowerCase());
    if (found) return Buffer.from(await (await item.getType(found)).arrayBuffer());
  }
  return null;
}

app.whenReady().then(async () => {
  let files = [];
  const items = await clipboard.read();

  // 1. PowerShell: the most reliable on Windows, and the slowest.
  if (process.platform === "win32") {
    try {
      const stdout = execSync(
        'powershell -NoProfile -Command "Get-Clipboard -Format FileDropList | Select-Object -ExpandProperty FullName"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const found = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      console.log("1. PowerShell:", found);
      if (found.length) files = found;
    } catch (err) {
      console.log("1. PowerShell failed:", err.message);
    }
  }

  // 2. FileNameW: null-separated UTF-16 paths.
  try {
    const buffer = await bytesOf(items, osFormat("FileNameW"));
    const found = buffer ? buffer.toString("utf16le").split("\0").filter(Boolean) : [];
    console.log("2. FileNameW:", found);
    if (!files.length) files = found;
  } catch (err) {
    console.log("2. FileNameW failed:", err.message);
  }

  // 3. text/uri-list: file:// URLs.
  try {
    const buffer = await bytesOf(items, "text/uri-list");
    const found = (buffer ? buffer.toString("utf8") : "").split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("file://"))
      .map((line) => decodeURIComponent(line).replace(/^file:\/\/\/?/, ""));
    console.log("3. text/uri-list:", found);
    if (!files.length) files = found;
  } catch (err) {
    console.log("3. text/uri-list failed:", err.message);
  }

  console.log("resolved:", files);
  app.exit(0);
});
