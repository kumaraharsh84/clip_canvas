const { app } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  console.log("=== START CONTENT PROJECTION VERIFICATION ===");
  try {
    const db = require("../src/main/db");

    // 1. Setup mock data
    console.log("1. Creating mock clips (mix of text, large text, inline image, and file)...");
    
    // Large text (approx 50 KB)
    const largeText = "A".repeat(50 * 1024);
    
    // Inline image data URL (approx 20 KB base64)
    const mockImageBase64 = "data:image/png;base64," + "B".repeat(20 * 1024);
    
    const personalWorkspaceId = db.getDefaultWorkspaceId();
    
    // Insert text clip
    const c1 = db.insertClip({
      type: "text",
      content: "Hello ClipCanvas World!",
      source: "verification-test",
      workspace_id: personalWorkspaceId
    });
    
    // Insert large text clip
    const c2 = db.insertClip({
      type: "text",
      content: largeText,
      source: "verification-test",
      workspace_id: personalWorkspaceId
    });
    
    // Insert inline legacy image clip
    const c3 = db.insertClip({
      type: "image",
      content: mockImageBase64,
      source: "verification-test",
      workspace_id: personalWorkspaceId,
      storage_mode: "inline"
    });
    
    // Insert file clip
    const c4 = db.insertClip({
      type: "file",
      content: "C:/path/to/my/test_document.pdf",
      source: "verification-test",
      workspace_id: personalWorkspaceId,
      original_path: "C:/path/to/my/test_document.pdf",
      mime_type: "application/pdf"
    });

    console.log(`   Mock clips inserted. IDs: ${c1.id}, ${c2.id}, ${c3.id}, ${c4.id}`);

    // 2. Measure payload size
    console.log("2. Measuring payload sizes...");
    
    // "Before" payload: simulate the old way (SELECT * from clips)
    const dbInstance = db.db;
    const oldRows = dbInstance.prepare("SELECT * FROM clips WHERE source = 'verification-test'").all();
    const oldJson = JSON.stringify(oldRows);
    const beforeBytes = Buffer.byteLength(oldJson);
    
    // "After" payload: new getClipSummaries()
    const newRows = db.getClipSummaries({ workspaceId: personalWorkspaceId });
    // Filter to only our verification ones to make the comparison direct
    const testNewRows = newRows.filter(r => r.source === "verification-test");
    const newJson = JSON.stringify(testNewRows);
    const afterBytes = Buffer.byteLength(newJson);
    
    const percentage = ((beforeBytes - afterBytes) / beforeBytes * 100).toFixed(2);
    
    console.log("\n=== PAYLOAD MEASUREMENT REPORT ===");
    console.log(`Before (SELECT *):        ${beforeBytes} bytes`);
    console.log(`After (getClipSummaries): ${afterBytes} bytes`);
    console.log(`Payload Size Reduction:   ${percentage}%`);
    console.log("==================================\n");

    // 3. Verify assertions
    console.log("3. Verifying schema content projection properties...");
    
    for (const row of testNewRows) {
      if (row.hasOwnProperty("content")) {
        throw new Error(`Assertion Failed: Summary row has 'content' property: ${JSON.stringify(row)}`);
      }
      console.log(`   [OK] Summary row ID ${row.id} does not contain 'content'`);
    }

    // Verify getClipById retrieves the full content
    console.log("4. Verifying getClipById returns full content...");
    const fullLargeClip = db.getClipById(c2.id);
    if (!fullLargeClip.content || fullLargeClip.content.length !== 50 * 1024) {
      throw new Error("Assertion Failed: getClipById did not return full content for large text clip");
    }
    console.log(`   [OK] getClipById returned full content (${fullLargeClip.content.length} characters)`);

    const fullImageClip = db.getClipById(c3.id);
    if (!fullImageClip.content || !fullImageClip.content.startsWith("data:image/png;base64,")) {
      throw new Error("Assertion Failed: getClipById did not return content for inline image clip");
    }
    console.log(`   [OK] getClipById returned inline image content`);

    // 5. Cleanup
    console.log("5. Cleaning up mock clips...");
    dbInstance.prepare("DELETE FROM clips WHERE source = 'verification-test'").run();
    console.log("   [OK] Cleanup complete.");

    console.log("=== VERIFICATION SUCCESSFUL ===");
    app.exit(0);
  } catch (err) {
    console.error("=== VERIFICATION FAILED ===");
    console.error(err);
    app.exit(1);
  }
});
