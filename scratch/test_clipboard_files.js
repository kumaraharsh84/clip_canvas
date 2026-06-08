const { app, clipboard } = require("electron");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

app.whenReady().then(() => {
  console.log("=== TESTING ROBUST FILE EXTRACTION ===");
  
  let files = [];
  
  // Method 1: PowerShell (most reliable on Windows)
  if (process.platform === "win32") {
    try {
      console.log("Method 1: Executing PowerShell...");
      const stdout = execSync(
        'powershell -NoProfile -Command "Get-Clipboard -Format FileDropList | Select-Object -ExpandProperty FullName"',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const psFiles = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      console.log("  PowerShell found files:", psFiles);
      if (psFiles.length > 0) files = psFiles;
    } catch (err) {
      console.error("  PowerShell failed:", err.message);
    }
  }
  
  // Method 2: FileNameW buffer
  if (files.length === 0 && process.platform === "win32") {
    try {
      console.log("Method 2: Reading FileNameW buffer...");
      const buffer = clipboard.readBuffer("FileNameW");
      console.log("  Buffer length:", buffer.length);
      if (buffer.length > 0) {
        const str = buffer.toString("utf16le");
        // FileNameW can contain multiple null-separated paths
        const fnwFiles = str.split("\0").filter(Boolean);
        console.log("  FileNameW found files:", fnwFiles);
        if (fnwFiles.length > 0) files = fnwFiles;
      }
    } catch (err) {
      console.error("  FileNameW failed:", err.message);
    }
  }
  
  // Method 3: text/uri-list
  if (files.length === 0) {
    try {
      console.log("Method 3: Reading text/uri-list...");
      const uriList = clipboard.read("text/uri-list");
      console.log("  uriList raw value:", JSON.stringify(uriList));
      if (uriList) {
        const uriFiles = uriList.split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.startsWith("file://"))
          .map(line => {
            try {
              // Clean file:// URLs
              let decoded = decodeURIComponent(line);
              decoded = decoded.replace(/^file:\/\/\/?/, "");
              if (process.platform === "win32" && !/^[a-zA-Z]:/.test(decoded)) {
                // If it starts with a slash like /C:/path, strip the leading slash
                if (decoded.startsWith("/")) decoded = decoded.slice(1);
              }
              return decoded;
            } catch (e) {
              return line;
            }
          });
        console.log("  uri-list found files:", uriFiles);
        if (uriFiles.length > 0) files = uriFiles;
      }
    } catch (err) {
      console.error("  uri-list failed:", err.message);
    }
  }

  console.log("=== FINAL RESOLVED FILES ===");
  console.log(files);
  app.exit(0);
});
