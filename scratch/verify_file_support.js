const { app } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  console.log("=== START FILE SUPPORT V2 VERIFICATION ===");
  try {
    // 1. Verify schema has the new columns
    console.log("1. Verifying database schema...");
    const db = require("../src/main/db");
    const dbInstance = db.db; // direct better-sqlite3 instance
    const columnsInfo = dbInstance.prepare("PRAGMA table_info(clips)").all();
    const columns = columnsInfo.map(c => c.name);
    console.log("   Found clips table columns:", columns);

    const requiredColumns = ["original_path", "mime_type"];
    for (const reqCol of requiredColumns) {
      if (columns.includes(reqCol)) {
        console.log(`   [OK] Column present: ${reqCol}`);
      } else {
        throw new Error(`Required column missing: ${reqCol}`);
      }
    }

    // 2. Create a temporary original file on disk
    console.log("2. Creating a temporary original file...");
    const tempDir = path.join(__dirname, "temp_test_files");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    const originalFilePath = path.join(tempDir, "test_doc.txt");
    const testContent = "Hello ClipCanvas File Support Verification!";
    fs.writeFileSync(originalFilePath, testContent, "utf8");
    console.log("   Original file created at:", originalFilePath);

    // 3. Simulating file capture flow
    console.log("3. Simulating clipboard file capture...");
    // Use the exported ClipboardMonitor instance directly
    const monitor = require("../src/main/clipboard");

    // Trigger captureFileClip directly
    const clipId = monitor.captureFileClip(originalFilePath);
    console.log("   Clip captured. Generated ID:", clipId);
    if (!clipId) {
      throw new Error("Failed to capture clip");
    }

    // Load from database
    const clip = db.getClip(clipId);
    console.log("   Loaded clip details from database:", {
      id: clip.id,
      type: clip.type,
      title: clip.title,
      file_size_bytes: clip.file_size_bytes,
      storage_mode: clip.storage_mode,
      asset_path: clip.asset_path,
      original_path: clip.original_path,
      mime_type: clip.mime_type
    });

    if (clip.type !== "file") {
      throw new Error(`Clip type is not "file": ${clip.type}`);
    }
    if (clip.storage_mode !== "local") {
      throw new Error(`Clip storage_mode is not "local": ${clip.storage_mode}`);
    }
    if (clip.file_size_bytes !== testContent.length) {
      throw new Error(`File size mismatch: expected ${testContent.length}, got ${clip.file_size_bytes}`);
    }
    if (clip.mime_type !== "text/plain") {
      throw new Error(`Mime type mismatch: expected text/plain, got ${clip.mime_type}`);
    }
    if (clip.original_path !== originalFilePath) {
      throw new Error(`Original path mismatch: expected ${originalFilePath}, got ${clip.original_path}`);
    }

    // Ensure it saved inside the storage/files/...
    const storageService = require("../src/main/storage/storageService");
    const savedAssetAbsPath = path.join(storageService.baseStoragePath, clip.asset_path);
    console.log("   Saved asset absolute path:", savedAssetAbsPath);
    if (!fs.existsSync(savedAssetAbsPath)) {
      throw new Error(`Asset file does not exist at: ${savedAssetAbsPath}`);
    }
    const savedContent = fs.readFileSync(savedAssetAbsPath, "utf8");
    if (savedContent !== testContent) {
      throw new Error(`Saved asset content mismatch: expected "${testContent}", got "${savedContent}"`);
    }
    console.log("   [OK] Saved asset verified successfully on disk");

    // 4. Test delete / trash safety (must delete asset copy but NOT original file)
    console.log("4. Verifying delete / trash safety...");
    // Move clip to trash
    db.trashClip(clip.id);
    console.log("   Clip moved to trash. Now emptying trash...");
    db.emptyTrash(clip.workspace_id);

    // Ensure database row is deleted
    const checkRow = dbInstance.prepare("SELECT * FROM clips WHERE id = ?").get(clip.id);
    if (checkRow) {
      throw new Error(`Clip row ${clip.id} was not deleted after emptyTrash`);
    }
    console.log("   [OK] Database row deleted successfully");

    // Ensure managed asset was deleted from disk
    if (fs.existsSync(savedAssetAbsPath)) {
      throw new Error(`Managed asset file was NOT deleted from storage: ${savedAssetAbsPath}`);
    }
    console.log("   [OK] Managed asset file deleted successfully from storage");

    // Ensure original file is STILL on disk (we must not delete user's original files!)
    if (!fs.existsSync(originalFilePath)) {
      throw new Error(`CRITICAL: Original user file was deleted from disk: ${originalFilePath}`);
    }
    console.log("   [OK] Original user file remains untouched on disk (safe deletion)");

    // Cleanup the original file and temp directory safely
    try {
      if (fs.existsSync(originalFilePath)) fs.unlinkSync(originalFilePath);
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup EPERM issues on Windows
    }
    console.log("   Cleanup completed successfully.");

    console.log("=== FILE SUPPORT V2 VERIFICATION SUCCESSFUL ===");
    app.exit(0);
  } catch (err) {
    console.error("=== FILE SUPPORT V2 VERIFICATION FAILED ===");
    console.error(err);
    app.exit(1);
  }
});
