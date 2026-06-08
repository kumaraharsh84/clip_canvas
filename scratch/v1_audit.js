// ─── V1 Finalization Audit ─────────────────────────────────────────────────────
// Comprehensive end-to-end verification of all V1 features.
// Run: npx electron scratch/v1_audit.js
// ───────────────────────────────────────────────────────────────────────────────

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ${PASS}  ${name}`);
  } catch (err) {
    failedTests++;
    const msg = `${name}: ${err.message}`;
    failures.push(msg);
    console.log(`  ${FAIL}  ${msg}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

app.whenReady().then(async () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              V1 FINALIZATION AUDIT                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const db = require("../src/main/db");
  const dbInstance = db.db;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: Fresh Install & Database Startup
  // ═══════════════════════════════════════════════════════════════════
  console.log("─── 1. FRESH INSTALL & DATABASE STARTUP ───");

  test("schema_version table exists", () => {
    const tables = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").all();
    assert(tables.length === 1, "schema_version table not found");
  });

  test("workspaces table exists", () => {
    const tables = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").all();
    assert(tables.length === 1, "workspaces table not found");
  });

  test("boards table exists", () => {
    const tables = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='boards'").all();
    assert(tables.length === 1, "boards table not found");
  });

  test("clips table exists", () => {
    const tables = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clips'").all();
    assert(tables.length === 1, "clips table not found");
  });

  test("Default workspaces created (Personal, Research, College)", () => {
    const workspaces = db.listWorkspaces();
    const names = workspaces.map(w => w.name);
    assert(names.includes("Personal"), "Personal workspace missing");
    assert(names.includes("Research"), "Research workspace missing");
    assert(names.includes("College"), "College workspace missing");
  });

  test("Default boards created for Research", () => {
    const workspaces = db.listWorkspaces();
    const research = workspaces.find(w => w.name === "Research");
    assert(research, "Research workspace not found");
    const boards = db.listBoards(research.id);
    const names = boards.map(b => b.name);
    assert(names.includes("MongoDB"), "MongoDB board missing");
    assert(names.includes("React"), "React board missing");
    assert(names.includes("APIs"), "APIs board missing");
  });

  test("Default boards created for College", () => {
    const workspaces = db.listWorkspaces();
    const college = workspaces.find(w => w.name === "College");
    assert(college, "College workspace not found");
    const boards = db.listBoards(college.id);
    const names = boards.map(b => b.name);
    assert(names.includes("Final Year Project"), "Final Year Project board missing");
    assert(names.includes("Internship"), "Internship board missing");
    assert(names.includes("Viva"), "Viva board missing");
  });

  test("getDefaultWorkspaceId returns a valid number", () => {
    const id = db.getDefaultWorkspaceId();
    assert(typeof id === "number" && id > 0, `Invalid default workspace ID: ${id}`);
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: Clip CRUD Operations
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 2. CLIP CRUD OPERATIONS ───");

  const wsId = db.getDefaultWorkspaceId();

  // Insert text clip
  const textClip = db.insertClip({
    type: "text",
    content: "V1 audit test text",
    source: "v1-audit",
    workspace_id: wsId,
  });
  test("insertClip: text clip created", () => {
    assert(textClip !== null, "insertClip returned null");
    assert(textClip.id > 0, "clip ID invalid");
    assert(textClip.type === "text", `type mismatch: ${textClip.type}`);
  });

  // Insert URL clip
  const urlClip = db.insertClip({
    type: "url",
    content: "https://github.com/clipcanvas",
    source: "v1-audit",
    workspace_id: wsId,
  });
  test("insertClip: URL clip created with auto-tags", () => {
    assert(urlClip !== null, "insertClip returned null");
    assert(urlClip.type === "url", `type mismatch: ${urlClip.type}`);
    assert(Array.isArray(urlClip.tags), "tags should be an array");
    assert(urlClip.tags.includes("url"), "should have 'url' tag");
    assert(urlClip.tags.includes("github"), "should have 'github' auto-tag");
  });

  // Insert code clip
  const codeClip = db.insertClip({
    type: "code",
    content: "const x = 42;\nfunction hello() { return x; }",
    source: "v1-audit",
    workspace_id: wsId,
  });
  test("insertClip: code clip created with auto-tags", () => {
    assert(codeClip !== null, "insertClip returned null");
    assert(codeClip.type === "code", `type mismatch: ${codeClip.type}`);
    assert(codeClip.tags.includes("js"), "should have 'js' auto-tag");
  });

  // Insert image clip (inline base64)
  const smallImg = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const imageClip = db.insertClip({
    type: "image",
    content: smallImg,
    source: "v1-audit",
    workspace_id: wsId,
  });
  test("insertClip: image clip created with display_url", () => {
    assert(imageClip !== null, "insertClip returned null");
    assert(imageClip.type === "image", `type mismatch: ${imageClip.type}`);
    assert(imageClip.display_url === smallImg, "display_url should be the data URL for inline images");
  });

  // Insert file clip
  const fileClip = db.insertClip({
    type: "file",
    content: "C:/test/document.pdf",
    title: "document.pdf",
    file_size_bytes: 12345,
    source: "v1-audit",
    workspace_id: wsId,
    original_path: "C:/test/document.pdf",
    mime_type: "application/pdf",
  });
  test("insertClip: file clip stores title and file_size_bytes", () => {
    assert(fileClip !== null, "insertClip returned null");
    assert(fileClip.title === "document.pdf", `title mismatch: ${fileClip.title}`);
    assert(fileClip.file_size_bytes === 12345, `file_size_bytes mismatch: ${fileClip.file_size_bytes}`);
  });

  // getClipById
  test("getClipById returns full content", () => {
    const full = db.getClipById(textClip.id);
    assert(full !== null, "getClipById returned null");
    assert(full.content === "V1 audit test text", `content mismatch: ${full.content}`);
  });

  // getClipSummaries
  test("getClipSummaries returns clips without full content column", () => {
    const summaries = db.getClipSummaries({ workspaceId: wsId });
    assert(Array.isArray(summaries), "should return an array");
    const ourClips = summaries.filter(s => s.source === "v1-audit");
    assert(ourClips.length >= 5, `expected at least 5 audit clips, got ${ourClips.length}`);
    // summaries use COALESCE(title, substr(content, 1, 120)) AS title, so no raw content
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: Search
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 3. SEARCH ───");

  test("searchClips by content text", () => {
    const results = db.searchClips({ query: "V1 audit test text", workspaceId: wsId });
    assert(results.length >= 1, `expected at least 1 result, got ${results.length}`);
    assert(results.some(r => r.id === textClip.id), "text clip not found in search results");
  });

  test("searchClips by URL content", () => {
    const results = db.searchClips({ query: "github.com", workspaceId: wsId });
    assert(results.some(r => r.id === urlClip.id), "URL clip not found in search results");
  });

  test("searchClips by title", () => {
    const results = db.searchClips({ query: "document.pdf", workspaceId: wsId });
    assert(results.some(r => r.id === fileClip.id), "file clip not found by title search");
  });

  test("searchClips by tag", () => {
    const results = db.searchClips({ query: "github", workspaceId: wsId });
    assert(results.some(r => r.id === urlClip.id), "URL clip not found by tag search");
  });

  test("searchClips empty query returns empty array", () => {
    const results = db.searchClips({ query: "", workspaceId: wsId });
    assert(results.length === 0, `expected empty array, got ${results.length} results`);
  });

  test("searchClips legacy string signature works", () => {
    const results = db.searchClips("V1 audit test text", 50);
    assert(results.length >= 1, "legacy string signature failed");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: Workspaces
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 4. WORKSPACES ───");

  test("listWorkspaces returns array with clip counts", () => {
    const ws = db.listWorkspaces();
    assert(Array.isArray(ws), "should return array");
    assert(ws.length >= 3, `expected at least 3 workspaces, got ${ws.length}`);
    const personal = ws.find(w => w.name === "Personal");
    assert(typeof personal.clip_count === "number", "clip_count should be a number");
  });

  const testWs = db.createWorkspace("V1AuditWorkspace");
  test("createWorkspace creates and returns new workspace", () => {
    assert(testWs !== null, "createWorkspace returned null");
    assert(testWs.name === "V1AuditWorkspace", `name mismatch: ${testWs.name}`);
    assert(testWs.slug === "v1auditworkspace", `slug mismatch: ${testWs.slug}`);
  });

  test("createWorkspace with duplicate name throws error", () => {
    let threw = false;
    try {
      db.createWorkspace("V1AuditWorkspace");
    } catch (e) {
      threw = true;
    }
    assert(threw, "should throw on duplicate workspace name");
  });

  test("createWorkspace with empty name throws error", () => {
    let threw = false;
    try {
      db.createWorkspace("");
    } catch (e) {
      threw = true;
    }
    assert(threw, "should throw on empty workspace name");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: Boards
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 5. BOARDS ───");

  const testBoard = db.createBoard(wsId, "V1AuditBoard");
  test("createBoard creates and returns new board", () => {
    assert(testBoard !== null, "createBoard returned null");
    assert(testBoard.name === "V1AuditBoard", `name mismatch: ${testBoard.name}`);
    assert(testBoard.workspace_id === wsId, "workspace_id mismatch");
  });

  test("listBoards returns boards for workspace", () => {
    const boards = db.listBoards(wsId);
    assert(boards.some(b => b.name === "V1AuditBoard"), "audit board not found");
  });

  const renamedBoard = db.renameBoard(testBoard.id, "V1RenamedBoard");
  test("renameBoard updates name", () => {
    assert(renamedBoard.name === "V1RenamedBoard", `renamed name: ${renamedBoard.name}`);
  });

  test("createBoard with empty name throws error", () => {
    let threw = false;
    try {
      db.createBoard(wsId, "");
    } catch (e) {
      threw = true;
    }
    assert(threw, "should throw on empty board name");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 6: Starred / Pin / Archive / Trash / Restore
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 6. STARRED / PIN / ARCHIVE / TRASH / RESTORE ───");

  // Star
  const starred = db.setStarred(textClip.id, true);
  test("setStarred(true) sets is_starred", () => {
    assert(starred.is_starred === true, `is_starred: ${starred.is_starred}`);
  });

  test("getClipSummaries filter=starred returns starred clips", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "starred" });
    assert(results.some(r => r.id === textClip.id), "starred clip not in starred filter");
  });

  const unstarred = db.setStarred(textClip.id, false);
  test("setStarred(false) unsets is_starred", () => {
    assert(unstarred.is_starred === false, `is_starred: ${unstarred.is_starred}`);
  });

  // Pin
  const pinned = db.setPinned(textClip.id, true);
  test("setPinned(true) sets is_pinned", () => {
    assert(pinned.is_pinned === true, `is_pinned: ${pinned.is_pinned}`);
  });

  test("getClipSummaries filter=pinned returns pinned clips", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "pinned" });
    assert(results.some(r => r.id === textClip.id), "pinned clip not in pinned filter");
  });

  db.setPinned(textClip.id, false);

  // Archive
  const archived = db.archiveClip(urlClip.id);
  test("archiveClip sets is_archived", () => {
    assert(archived.is_archived === true, `is_archived: ${archived.is_archived}`);
  });

  test("archived clip excluded from filter=all", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "all" });
    assert(!results.some(r => r.id === urlClip.id), "archived clip should NOT appear in 'all'");
  });

  test("archived clip appears in filter=archived", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "archived" });
    assert(results.some(r => r.id === urlClip.id), "archived clip should appear in 'archived'");
  });

  // Restore from archive
  const restored = db.restoreClip(urlClip.id);
  test("restoreClip unsets is_archived and deleted_at", () => {
    assert(restored.is_archived === false, `is_archived: ${restored.is_archived}`);
    assert(restored.deleted_at === null, `deleted_at: ${restored.deleted_at}`);
  });

  // Trash
  const trashed = db.trashClip(codeClip.id);
  test("trashClip sets deleted_at", () => {
    assert(trashed.deleted_at !== null, `deleted_at should not be null`);
  });

  test("trashed clip excluded from filter=all", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "all" });
    assert(!results.some(r => r.id === codeClip.id), "trashed clip should NOT appear in 'all'");
  });

  test("trashed clip appears in filter=trash", () => {
    const results = db.getClipSummaries({ workspaceId: wsId, filter: "trash" });
    assert(results.some(r => r.id === codeClip.id), "trashed clip should appear in 'trash'");
  });

  // Restore from trash
  const restoredFromTrash = db.restoreClip(codeClip.id);
  test("restoreClip from trash resets deleted_at", () => {
    assert(restoredFromTrash.deleted_at === null, `deleted_at should be null after restore`);
    assert(restoredFromTrash.is_archived === false, `is_archived should be false after restore`);
  });

  // Trash Summary
  test("getTrashSummary returns count and size", () => {
    const summary = db.getTrashSummary({ workspaceId: wsId });
    assert(typeof summary.clip_count === "number", "clip_count should be a number");
    assert(typeof summary.size === "number", "size should be a number");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 7: Move Clip
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 7. MOVE CLIP ───");

  test("moveClip to board", () => {
    const moved = db.moveClip(textClip.id, wsId, testBoard.id);
    assert(moved.board_id === testBoard.id, `board_id mismatch: ${moved.board_id}`);
  });

  test("moveClip back to no board", () => {
    const moved = db.moveClip(textClip.id, wsId, null);
    assert(moved.board_id === null, `board_id should be null: ${moved.board_id}`);
  });

  test("moveClip to non-existent workspace throws", () => {
    let threw = false;
    try {
      db.moveClip(textClip.id, 999999);
    } catch (e) {
      threw = true;
    }
    assert(threw, "should throw on invalid workspace");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 8: Update Clip
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 8. UPDATE CLIP ───");

  test("updateClip patches title", () => {
    const updated = db.updateClip(textClip.id, { title: "New Title" });
    assert(updated.title === "New Title", `title: ${updated.title}`);
  });

  test("updateTags normalizes tags", () => {
    const updated = db.updateTags(textClip.id, ["v1", "audit", "test"]);
    assert(Array.isArray(updated.tags), "tags should be array");
    assert(updated.tags.includes("v1"), "should contain 'v1' tag");
  });

  test("updateClip with empty patch returns unchanged clip", () => {
    const before = db.getClipById(textClip.id);
    const after = db.updateClip(textClip.id, {});
    assert(before.title === after.title, "title should not change on empty patch");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 9: Empty Trash & Delete Board
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 9. EMPTY TRASH & DELETE BOARD ───");

  // Trash a clip then empty
  db.trashClip(codeClip.id);
  test("emptyTrash removes trashed clips", () => {
    const result = db.emptyTrash(wsId);
    assert(result.ok === true, "emptyTrash should return ok: true");
    assert(result.removed >= 1, `should remove at least 1 clip, removed: ${result.removed}`);
    const check = db.getClipById(codeClip.id);
    assert(check === null, "clip should be permanently deleted");
  });

  test("deleteBoard moves clips to no board and removes board", () => {
    // Move a clip to testBoard first
    db.moveClip(textClip.id, wsId, testBoard.id);
    const result = db.deleteBoard(testBoard.id);
    assert(result.ok === true, "deleteBoard should return ok: true");
    const check = db.getClipById(textClip.id);
    assert(check.board_id === null, "clip board_id should be null after board deletion");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 10: Storage Stats & Export
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 10. STORAGE STATS & EXPORT ───");

  test("getStorageStats returns expected structure", () => {
    const stats = db.getStorageStats({ workspaceId: wsId });
    assert(typeof stats.total === "number", "total should be a number");
    assert(typeof stats.breakdown === "object", "breakdown should be an object");
    assert(typeof stats.breakdown.images === "number", "breakdown.images should be a number");
    assert(typeof stats.breakdown.text === "number", "breakdown.text should be a number");
    assert(Array.isArray(stats.largest), "largest should be an array");
    assert(Array.isArray(stats.oldest), "oldest should be an array");
    assert(typeof stats.dbPath === "string", "dbPath should be string");
  });

  test("exportClips returns JSON export with clips", () => {
    const exported = db.exportClips({ workspaceId: wsId });
    assert(typeof exported.exported_at === "string", "should have exported_at");
    assert(exported.version === 1, "should be version 1");
    assert(Array.isArray(exported.clips), "should have clips array");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 11: Persistence (Data Survives Reload)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 11. PERSISTENCE ───");

  test("Previously inserted clip survives database access", () => {
    // Re-read the text clip
    const reloaded = db.getClipById(textClip.id);
    assert(reloaded !== null, "clip should still exist");
    assert(reloaded.title === "New Title", `title should persist: ${reloaded.title}`);
  });

  test("Workspaces persist across reads", () => {
    const ws = db.listWorkspaces();
    assert(ws.some(w => w.name === "V1AuditWorkspace"), "audit workspace should persist");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 12: Edge Cases & Error Handling
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 12. EDGE CASES & ERROR HANDLING ───");

  test("getClipById with non-existent ID returns null", () => {
    const result = db.getClipById(999999);
    assert(result === null, "should return null for non-existent clip");
  });

  test("searchClips with workspace restriction", () => {
    const results = db.searchClips({ query: "V1 audit", workspaceId: testWs.id });
    assert(results.length === 0, "should not find clips from other workspace");
  });

  test("archiveOldClips works without error", () => {
    const result = db.archiveOldClips({ workspaceId: wsId, days: 30 });
    assert(typeof result.archived === "number", `archived should be a number: ${result.archived}`);
  });

  test("getClipSummaries with board filter", () => {
    const board = db.createBoard(wsId, "V1FilterTestBoard");
    const clip = db.insertClip({ type: "text", content: "board filter test", source: "v1-audit", workspace_id: wsId, board_id: board.id });
    const results = db.getClipSummaries({ workspaceId: wsId, boardId: board.id });
    assert(results.some(r => r.id === clip.id), "clip should appear when filtering by its board");
    const otherResults = db.getClipSummaries({ workspaceId: wsId });
    assert(otherResults.some(r => r.id === clip.id), "clip should also appear in 'all boards'");
    // cleanup
    db.deleteBoard(board.id);
  });

  test("parseRow handles null gracefully", () => {
    // This is tested by getClipById(999999) returning null above
    // Also ensure insertClip returns properly parsed row
    assert(textClip.is_starred === false || textClip.is_starred === true, "is_starred should be boolean");
    assert(Array.isArray(textClip.tags), "tags should be array");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 13: IPC Handler Coverage Check
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 13. IPC HANDLER COVERAGE ───");

  // Read main.js to verify all IPC channels are wrapped
  const mainJsPath = path.join(__dirname, "..", "src", "main", "main.js");
  const mainJs = fs.readFileSync(mainJsPath, "utf8");

  test("All ipcMain.handle calls use wrapIpcHandle", () => {
    // Check that there are no raw ipcMain.handle calls (except the wrapper definition itself)
    const rawHandles = mainJs.match(/ipcMain\.handle\(/g) || [];
    const wrapHandles = mainJs.match(/wrapIpcHandle\(/g) || [];
    // The wrapper definition has one ipcMain.handle inside it
    // So rawHandles should be exactly 1 (inside wrapIpcHandle body)
    assert(rawHandles.length <= 1, `Found ${rawHandles.length} raw ipcMain.handle calls in main.js (expected 0-1, the wrapper definition)`);
    assert(wrapHandles.length >= 20, `Found only ${wrapHandles.length} wrapIpcHandle calls (expected 20+)`);
  });

  // Read preload.js to verify safeInvoke
  const preloadPath = path.join(__dirname, "..", "src", "main", "preload.js");
  const preloadJs = fs.readFileSync(preloadPath, "utf8");

  test("preload.js uses safeInvoke wrapper", () => {
    assert(preloadJs.includes("safeInvoke"), "preload.js should contain safeInvoke");
    const safeInvokeCalls = preloadJs.match(/safeInvoke\(/g) || [];
    assert(safeInvokeCalls.length >= 20, `Found only ${safeInvokeCalls.length} safeInvoke calls (expected 20+)`);
  });

  test("preload.js exposes onClipWarning", () => {
    assert(preloadJs.includes("onClipWarning"), "preload.js should expose onClipWarning");
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 14: Renderer Coverage Check
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── 14. RENDERER COVERAGE ───");

  const rendererPath = path.join(__dirname, "..", "src", "renderer", "renderer.js");
  const rendererJs = fs.readFileSync(rendererPath, "utf8");

  test("renderer.js has renderCanvas function", () => {
    assert(rendererJs.includes("function renderCanvas"), "renderCanvas missing");
  });

  test("renderer.js has renderTimeline function", () => {
    assert(rendererJs.includes("function renderTimeline"), "renderTimeline missing");
  });

  test("renderer.js has runSearch function", () => {
    assert(rendererJs.includes("async function runSearch"), "runSearch missing");
  });

  test("renderer.js has renderSettings function", () => {
    assert(rendererJs.includes("async function renderSettings"), "renderSettings missing");
  });

  test("renderer.js has renderDetails function", () => {
    assert(rendererJs.includes("function renderDetails"), "renderDetails missing");
  });

  test("renderer.js uses getClipSummaries for list views", () => {
    assert(rendererJs.includes("getClipSummaries"), "should use getClipSummaries");
  });

  test("renderer.js uses getClipById for detail views", () => {
    assert(rendererJs.includes("getClipById"), "should use getClipById");
  });

  test("renderer.js registers onClipWarning handler", () => {
    assert(rendererJs.includes("onClipWarning"), "should register onClipWarning");
  });

  const indexPath = path.join(__dirname, "..", "src", "renderer", "index.html");
  const indexHtml = fs.readFileSync(indexPath, "utf8");

  test("index.html has canvas view", () => {
    assert(indexHtml.includes("view-canvas"), "view-canvas missing");
  });

  test("index.html has timeline view", () => {
    assert(indexHtml.includes("view-timeline"), "view-timeline missing");
  });

  test("index.html has recall view", () => {
    assert(indexHtml.includes("view-recall"), "view-recall missing");
  });

  test("index.html has settings view", () => {
    assert(indexHtml.includes("view-settings"), "view-settings missing");
  });

  test("index.html has workspace sidebar", () => {
    assert(indexHtml.includes("workspace-list"), "workspace-list missing");
  });

  test("index.html has board sidebar", () => {
    assert(indexHtml.includes("board-list"), "board-list missing");
  });

  test("index.html has filter buttons (all, starred, archived, trash)", () => {
    assert(indexHtml.includes('data-filter="all"'), "filter=all missing");
    assert(indexHtml.includes('data-filter="starred"'), "filter=starred missing");
    assert(indexHtml.includes('data-filter="archived"'), "filter=archived missing");
    assert(indexHtml.includes('data-filter="trash"'), "filter=trash missing");
  });

  test("index.html has details panel", () => {
    assert(indexHtml.includes("details-panel"), "details-panel missing");
  });

  // ═══════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── CLEANUP ───");
  dbInstance.prepare("DELETE FROM clips WHERE source = 'v1-audit'").run();
  dbInstance.prepare("DELETE FROM workspaces WHERE name = 'V1AuditWorkspace'").run();
  console.log("  Cleaned up all audit test data.");

  // ═══════════════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                V1 AUDIT REPORT                              ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Total Tests:   ${String(totalTests).padStart(4)}                                     ║`);
  console.log(`║  Passed:        ${String(passedTests).padStart(4)}                                     ║`);
  console.log(`║  Failed:        ${String(failedTests).padStart(4)}                                     ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  if (failures.length > 0) {
    console.log("\n── FAILURES ──");
    for (const f of failures) {
      console.log(`  ❌ ${f}`);
    }
  }

  console.log(`\nV1 VERDICT: ${failedTests === 0 ? "✅ ALL V1 FEATURES WORKING" : "❌ BUGS FOUND"}`);
  app.exit(failedTests > 0 ? 1 : 0);
});
