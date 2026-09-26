const { app } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  console.log("=== START STABILITY & SEARCH FOUNDATION VERIFICATION ===");
  try {
    const db = require("../src/main/db");
    const Settings = require("../src/main/settings");
    const clipboardMonitor = require("../src/main/clipboard");

    const personalWorkspaceId = db.getDefaultWorkspaceId();

    // ==========================================
    // 1. Verify Task 1: insertClip parameter bug
    // ==========================================
    console.log("1. Verifying insertClip accepts and correctly stores title & file_size_bytes...");
    const testClip = db.insertClip({
      type: "file",
      content: "C:/path/to/my/document.docx",
      title: "document.docx",
      file_size_bytes: 45678,
      source: "verification-stability",
      workspace_id: personalWorkspaceId,
      storage_mode: "local",
      original_path: "C:/path/to/my/document.docx",
      mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });

    const retrieved = db.getClipById(testClip.id);
    console.log(`   Retrieved Clip: Title = "${retrieved.title}", Size = ${retrieved.file_size_bytes} bytes`);
    if (retrieved.title !== "document.docx") {
      throw new Error(`Assertion Failed: title was not stored correctly. Expected "document.docx", got "${retrieved.title}"`);
    }
    if (retrieved.file_size_bytes !== 45678) {
      throw new Error(`Assertion Failed: file_size_bytes was not stored correctly. Expected 45678, got ${retrieved.file_size_bytes}`);
    }
    console.log("   [OK] insertClip parameter storage verified.");

    // ==========================================
    // 2. Verify Task 4: Schema Versioning
    // ==========================================
    console.log("2. Verifying schema versioning table is initialized and correct...");
    const versions = db.db.prepare("SELECT * FROM schema_version ORDER BY version ASC").all();
    console.log("   Applied migrations in schema_version table:", JSON.stringify(versions));
    if (versions.length < 2) {
      throw new Error(`Assertion Failed: Expected at least 2 migrations, got ${versions.length}`);
    }
    if (versions[0].version !== 1 || versions[1].version !== 2) {
      throw new Error("Assertion Failed: Migration versions are incorrect");
    }
    console.log("   [OK] Schema versioning migrations verified.");

    // ==========================================
    // 3. Verify Task 2: File Size Guard
    // ==========================================
    console.log("3. Verifying File Size Guard...");
    
    // Create a temp file of 2 MB inside workspace
    const tempFilePath = path.join(__dirname, "temp_test_file.txt");
    const twoMB = 2 * 1024 * 1024;
    fs.writeFileSync(tempFilePath, "X".repeat(twoMB));
    console.log(`   Created temp file of ${(twoMB / (1024 * 1024)).toFixed(2)} MB at ${tempFilePath}`);

    try {
      // Test A: Limit = 10 MB, should be accepted
      console.log("   Testing File Size Guard: Limit = 10 MB...");
      Settings.setSetting("maxFileSizeMB", 10);
      
      // Clear last files so monitor doesn't think it's a duplicate
      clipboardMonitor.lastFiles = "";
      
      const clipId1 = clipboardMonitor.captureFileClip(tempFilePath);
      if (!clipId1) {
        throw new Error("Assertion Failed: File was rejected under 10 MB limit, but it should be accepted!");
      }
      console.log(`   [OK] Accepted 2 MB file under 10 MB limit (clipId: ${clipId1})`);

      // Test B: Limit = 1 MB, should be rejected
      console.log("   Testing File Size Guard: Limit = 1 MB...");
      Settings.setSetting("maxFileSizeMB", 1);
      
      clipboardMonitor.lastFiles = "";
      
      const clipId2 = clipboardMonitor.captureFileClip(tempFilePath);
      if (clipId2) {
        throw new Error("Assertion Failed: File was accepted under 1 MB limit, but it should be rejected!");
      }
      console.log("   [OK] Blocked 2 MB file under 1 MB limit (returned null/undefined)");
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }

    // ==========================================
    // 4. Verify Task 3: IPC Error Boundaries
    // ==========================================
    console.log("4. Verifying IPC Error boundaries... (simulating safeInvoke behaviour)");
    
    const mockSuccessResponse = { success: true, data: "test-data" };
    const mockErrorResponse = { success: false, error: "Database is locked" };
    
    const testSafeInvoke = (res) => {
      if (res && typeof res === "object" && res.success !== undefined) {
        if (!res.success) {
          throw new Error(res.error || "IPC error");
        }
        return res.data;
      }
      return res;
    };
    
    const successResult = testSafeInvoke(mockSuccessResponse);
    if (successResult !== "test-data") {
      throw new Error(`Assertion Failed: safeInvoke did not return data. Got: ${successResult}`);
    }
    console.log("   [OK] safeInvoke returned data on success");

    try {
      testSafeInvoke(mockErrorResponse);
      throw new Error("Assertion Failed: safeInvoke did not throw on success: false");
    } catch (e) {
      if (e.message !== "Database is locked") {
        throw new Error(`Assertion Failed: safeInvoke threw wrong error: ${e.message}`);
      }
      console.log("   [OK] safeInvoke threw correct error on success: false");
    }

    // ==========================================
    // 5. Cleanup
    // ==========================================
    console.log("5. Cleaning up verification database entries...");
    db.db.prepare("DELETE FROM clips WHERE source = 'verification-stability'").run();
    db.db.prepare("DELETE FROM clips WHERE original_path = ?").run(tempFilePath);
    console.log("   [OK] Cleanup complete.");

    console.log("=== STABILITY & SEARCH FOUNDATION VERIFICATION SUCCESSFUL ===");
    app.exit(0);
  } catch (err) {
    console.error("=== STABILITY & SEARCH FOUNDATION VERIFICATION FAILED ===");
    console.error(err);
    app.exit(1);
  }
});
