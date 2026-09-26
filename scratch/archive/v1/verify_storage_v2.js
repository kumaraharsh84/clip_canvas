const { app } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  console.log("=== START STORAGE V2 VERIFICATION ===");
  try {
    // 1. Verify storageService creation and base directories
    console.log("1. Loading storageService...");
    const storageService = require("../src/main/storage/storageService");
    console.log("   baseStoragePath:", storageService.baseStoragePath);
    
    // Ensure all directories exist
    const dirs = ["images", "files", "thumbnails/images", "thumbnails/pdfs", "thumbnails/videos"];
    for (const d of dirs) {
      const fullPath = path.join(storageService.baseStoragePath, d);
      if (fs.existsSync(fullPath)) {
        console.log(`   [OK] Directory exists: ${d}`);
      } else {
        throw new Error(`Directory does not exist: ${d}`);
      }
    }

    // 2. Test storageService write/read/delete operations
    console.log("2. Testing saveImage and loadImage...");
    const testImageBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 white pixel png
    const relPath = storageService.generateAssetPath("image", "webp");
    console.log("   Generated relative path:", relPath);
    
    const savedPath = storageService.saveImage(testImageBase64, relPath);
    console.log("   Saved to absolute path:", savedPath);
    if (!fs.existsSync(savedPath)) {
      throw new Error(`File was not created at absolute path: ${savedPath}`);
    }

    const loadedBuffer = storageService.loadImage(relPath);
    console.log("   Loaded buffer byte size:", loadedBuffer.length);
    if (loadedBuffer.length === 0) {
      throw new Error("Loaded buffer is empty");
    }

    // 3. Verify Database migrations and check if schema has the new columns
    console.log("3. Verifying database migrations...");
    const db = require("../src/main/db");
    
    const dbInstance = db.db; // direct better-sqlite3 instance
    const columnsInfo = dbInstance.prepare("PRAGMA table_info(clips)").all();
    const columns = columnsInfo.map(c => c.name);
    console.log("   Found clips table columns:", columns);
    
    const requiredColumns = ["asset_path", "asset_hash", "storage_mode", "thumbnail_path"];
    for (const reqCol of requiredColumns) {
      if (columns.includes(reqCol)) {
        console.log(`   [OK] Column present: ${reqCol}`);
      } else {
        throw new Error(`Required column missing: ${reqCol}`);
      }
    }

    // 4. Test Compatibility Layer and insertClip
    console.log("4. Inserting a dummy local storage clip...");
    const dummyClip = db.insertClip({
      type: "image",
      content: "placeholder-content",
      source: "verification-test",
      asset_path: relPath,
      asset_hash: "dummyhash123",
      storage_mode: "local",
      thumbnail_path: null
    });
    
    console.log("   Inserted Clip details:", {
      id: dummyClip.id,
      type: dummyClip.type,
      storage_mode: dummyClip.storage_mode,
      asset_path: dummyClip.asset_path,
      display_url: dummyClip.display_url
    });

    if (!dummyClip.display_url) {
      throw new Error("display_url is missing on returned clip row");
    }
    if (!dummyClip.display_url.startsWith("file:///")) {
      throw new Error(`display_url should be a file:/// URL, got: ${dummyClip.display_url}`);
    }
    console.log("   [OK] display_url matches file:// pattern");

    // 5. Test copyToClipboard logic with ID (simulated implementation)
    console.log("5. Testing copyToClipboard fallback using ID...");
    const copyToClipboardSim = (clipId) => {
      const clip = db.getClip(clipId);
      if (clip) {
        if (clip.type === "image" && clip.storage_mode === "local" && clip.asset_path) {
          const buffer = storageService.loadImage(clip.asset_path);
          const { nativeImage } = require("electron");
          const image = nativeImage.createFromBuffer(buffer);
          if (!image || image.isEmpty()) {
            throw new Error("Failed to create nativeImage from buffer");
          }
          return true;
        }
      }
      return false;
    };
    
    const copyResult = copyToClipboardSim(dummyClip.id);
    console.log("   copyToClipboard returned:", copyResult);
    if (!copyResult) {
      throw new Error("copyToClipboard simulation failed");
    }
    console.log("   [OK] copyToClipboard simulation executed successfully");

    // 6. Test deleteAsset and cleanup
    console.log("6. Cleaning up test clip and asset...");
    // Move clip to trash
    db.trashClip(dummyClip.id);
    console.log("   Clip moved to trash. Now emptying trash...");
    db.emptyTrash(dummyClip.workspace_id);
    
    // Check if database row is deleted
    const checkRow = dbInstance.prepare("SELECT * FROM clips WHERE id = ?").get(dummyClip.id);
    if (checkRow) {
      throw new Error(`Clip row ${dummyClip.id} was not deleted after emptyTrash`);
    }
    console.log("   [OK] Clip row successfully purged from database");

    // Check if asset file was deleted from disk
    if (fs.existsSync(savedPath)) {
      throw new Error("Asset file was not deleted from disk by emptyTrash");
    }
    console.log("   [OK] Asset file successfully deleted from disk");

    console.log("=== VERIFICATION SUCCESSFUL ===");
    app.exit(0);
  } catch (err) {
    console.error("=== VERIFICATION FAILED ===");
    console.error(err);
    app.exit(1);
  }
});
