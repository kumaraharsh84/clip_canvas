// ─── src/main/db.js ──────────────────────────────────────────────────────────
// SQLite data layer for ClipCanvas, on better-sqlite3 (synchronous by design --
// every call here runs in the main process and finishes before it returns).
//
// RECONSTRUCTED against the live database at
//   %APPDATA%/clipcanvas/clipcanvas.db
// after the original source was lost. The schema below is not a guess: it was
// read back out of that file, which already carries 5 applied migrations and
// 649 live clips. The method names and argument shapes are the ones the
// harnesses in scratch/ call, so those still run unchanged.
//
// TWO THINGS THAT BITE IF YOU FORGET THEM
//
// 1. created_at / updated_at / deleted_at are INTEGER UNIX **SECONDS**
//    (strftime('%s','now')), not milliseconds and not ISO strings. Passing one
//    to `new Date()` without multiplying dates everything to 1970.
//
// 2. clips_fts is an EXTERNAL-CONTENT fts5 table (content='clips'). Its rows
//    are maintained by the clips_ai/au/ad triggers, so never write to it
//    directly -- and image clips are indexed with an empty body on purpose, to
//    keep base64 payloads out of the search index.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const SCHEMA_VERSION = 5;

class ClipDatabase {
  /**
   * @param {string} dbPath   full path to clipcanvas.db
   * @param {string} storageDir  root for image/file assets (asset_path is
   *                             stored relative to it)
   */
  constructor(dbPath, storageDir) {
    this.dbPath = dbPath;
    this.storageDir = storageDir;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");

    this.migrate();
    this.seed();
  }

  close() { try { this.db.close(); } catch (_) {} }

  // ── Migrations ─────────────────────────────────────────────────────────────
  // Additive only, exactly as the README describes: CREATE TABLE IF NOT EXISTS,
  // ALTER TABLE ... ADD COLUMN guarded by a column probe, and default seeding.
  // An existing install must come through this untouched.
  migrate() {
    const db = this.db;

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        migrated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        UNIQUE (workspace_id, name)
      );

      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        content TEXT,
        title TEXT DEFAULT NULL,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        source TEXT DEFAULT 'clipboard',
        tags TEXT DEFAULT '[]',
        group_id TEXT DEFAULT NULL,
        workspace_id INTEGER,
        board_id INTEGER DEFAULT NULL,
        is_starred INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER DEFAULT NULL,
        canvas_x REAL DEFAULT NULL,
        canvas_y REAL DEFAULT NULL,
        pos_x REAL DEFAULT NULL,
        pos_y REAL DEFAULT NULL,
        is_free_position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now')),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE SET NULL
      );
    `);

    // Columns added by later migrations on existing installs.
    const addColumn = (table, column, decl) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("clips", "asset_path", "TEXT DEFAULT NULL");
    addColumn("clips", "asset_hash", "TEXT DEFAULT NULL");
    addColumn("clips", "storage_mode", "TEXT DEFAULT 'inline'");
    addColumn("clips", "thumbnail_path", "TEXT DEFAULT NULL");
    addColumn("clips", "original_path", "TEXT DEFAULT NULL");
    addColumn("clips", "mime_type", "TEXT DEFAULT NULL");
    addColumn("clips", "migration_verified", "INTEGER DEFAULT 0");
    addColumn("clips", "year", "INTEGER DEFAULT NULL");
    addColumn("clips", "month", "INTEGER DEFAULT NULL");
    addColumn("clips", "day", "INTEGER DEFAULT NULL");
    addColumn("clips", "weekday", "INTEGER DEFAULT NULL");
    addColumn("clips", "hour", "INTEGER DEFAULT NULL");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id, name);
      CREATE INDEX IF NOT EXISTS idx_clips_canvas
        ON clips(workspace_id, board_id, deleted_at, is_archived, is_pinned, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clips_starred
        ON clips(workspace_id, board_id, is_starred, deleted_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clips_trash
        ON clips(workspace_id, board_id, deleted_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clips_storage
        ON clips(workspace_id, deleted_at, type, file_size_bytes, created_at);
      CREATE INDEX IF NOT EXISTS idx_clips_range_query
        ON clips(workspace_id, deleted_at, is_archived, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_clips_time_hierarchy
        ON clips(workspace_id, deleted_at, is_archived, year, month, day, hour);
    `);

    const have = db.prepare("SELECT version FROM schema_version WHERE version = ?");
    const mark = db.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)");
    for (let v = 1; v <= SCHEMA_VERSION; v++) if (!have.get(v)) mark.run(v);
  }

  seed() {
    const db = this.db;
    const count = db.prepare("SELECT COUNT(*) n FROM workspaces").get().n;
    if (count > 0) return;

    const ins = db.prepare(
      "INSERT INTO workspaces (name, slug, is_default) VALUES (?, ?, 1)"
    );
    const insBoard = db.prepare(
      "INSERT OR IGNORE INTO boards (workspace_id, name) VALUES (?, ?)"
    );
    db.transaction(() => {
      const personal = ins.run("Personal", "personal").lastInsertRowid;
      const research = ins.run("Research", "research").lastInsertRowid;
      const college = ins.run("College", "college").lastInsertRowid;
      for (const b of ["MongoDB", "React", "APIs"]) insBoard.run(research, b);
      for (const b of ["Final Year Project", "Internship", "Viva"]) insBoard.run(college, b);
      void personal;
    })();
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────
  listWorkspaces() {
    return this.db.prepare(`
      SELECT w.*,
             (SELECT COUNT(*) FROM clips c
               WHERE c.workspace_id = w.id AND c.deleted_at IS NULL) AS clip_count
        FROM workspaces w
       ORDER BY w.is_default DESC, w.name COLLATE NOCASE ASC
    `).all();
  }

  createWorkspace(name) {
    const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const info = this.db
      .prepare("INSERT INTO workspaces (name, slug) VALUES (?, ?)")
      .run(String(name).trim(), slug || "ws-" + Date.now());
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(info.lastInsertRowid);
  }

  // ── Boards ─────────────────────────────────────────────────────────────────
  listBoards(workspaceId) {
    return this.db.prepare(`
      SELECT b.*,
             (SELECT COUNT(*) FROM clips c
               WHERE c.board_id = b.id AND c.deleted_at IS NULL) AS clip_count
        FROM boards b
       WHERE b.workspace_id = ?
       ORDER BY b.name COLLATE NOCASE ASC
    `).all(workspaceId);
  }

  createBoard(workspaceId, name) {
    const info = this.db
      .prepare("INSERT INTO boards (workspace_id, name) VALUES (?, ?)")
      .run(workspaceId, String(name).trim());
    return this.db.prepare("SELECT * FROM boards WHERE id = ?").get(info.lastInsertRowid);
  }

  renameBoard(id, name) {
    this.db.prepare("UPDATE boards SET name = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(String(name).trim(), id);
    return this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id);
  }

  deleteBoard(id) {
    // ON DELETE SET NULL on clips.board_id returns those clips to the workspace.
    this.db.prepare("DELETE FROM boards WHERE id = ?").run(id);
    return { ok: true };
  }

  // ── Reading clips ──────────────────────────────────────────────────────────
  /**
   * Shared WHERE builder. `filter` is one of:
   *   active (default) | starred | pinned | archived | trash | all
   */
  clipWhere(opts = {}) {
    const where = [];
    const params = [];

    if (opts.workspaceId) { where.push("c.workspace_id = ?"); params.push(opts.workspaceId); }
    if (opts.boardId) { where.push("c.board_id = ?"); params.push(opts.boardId); }
    if (opts.type) { where.push("c.type = ?"); params.push(opts.type); }

    switch (opts.filter || "active") {
      case "trash": where.push("c.deleted_at IS NOT NULL"); break;
      case "starred": where.push("c.deleted_at IS NULL AND c.is_starred = 1"); break;
      case "pinned": where.push("c.deleted_at IS NULL AND c.is_pinned = 1"); break;
      case "archived": where.push("c.deleted_at IS NULL AND c.is_archived = 1"); break;
      case "all": where.push("c.deleted_at IS NULL"); break;
      default: where.push("c.deleted_at IS NULL AND c.is_archived = 0"); break;
    }
    return { sql: where.length ? "WHERE " + where.join(" AND ") : "", params };
  }

  /** Newest-first page. `limit`/`offset`, or `beforeId` for keyset paging. */
  getClipPage(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 5000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const { sql, params } = this.clipWhere(opts);

    const rows = this.db.prepare(`
      SELECT c.* FROM clips c ${sql}
      ORDER BY c.is_pinned DESC, c.created_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = this.db
      .prepare(`SELECT COUNT(*) n FROM clips c ${sql}`)
      .get(...params).n;

    return { clips: rows.map(hydrate), total, limit, offset,
             hasMore: offset + rows.length < total };
  }

  /** Every matching clip. Bounded by `max` so a runaway call cannot OOM. */
  getClips(opts = {}) {
    const max = Math.min(Number(opts.max) || 20000, 100000);
    const { sql, params } = this.clipWhere(opts);
    return this.db.prepare(`
      SELECT c.* FROM clips c ${sql}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ?
    `).all(...params, max).map(hydrate);
  }

  /**
   * Metadata only -- no `content`. This is what the Time Canvas loads: it needs
   * every clip's timestamp and size to lay the canvas out, but the body text is
   * only needed for clips you actually zoom into, and pulling 5 MB of bodies
   * through IPC to render a treemap is most of what made the old load take 59s.
   */
  getClipSummaries(opts = {}) {
    const max = Math.min(Number(opts.max) || 50000, 200000);
    const { sql, params } = this.clipWhere(opts);
    return this.db.prepare(`
      SELECT c.id, c.type, c.title, c.source, c.tags, c.workspace_id, c.board_id,
             c.is_starred, c.is_archived, c.is_pinned, c.deleted_at,
             c.created_at, c.updated_at, c.file_size_bytes,
             c.storage_mode, c.asset_path, c.thumbnail_path, c.mime_type,
             c.year, c.month, c.day, c.hour,
             LENGTH(c.content) AS content_length,
             CASE WHEN c.type = 'image' THEN NULL
                  ELSE substr(c.content, 1, 4000) END AS content
        FROM clips c ${sql}
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?
    `).all(...params, max).map(hydrate);
  }

  getClipById(id) {
    const row = this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
  }

  /** Full body for one clip -- used when a card is zoomed into or opened. */
  getClipContent(id) {
    const row = this.db.prepare("SELECT id, type, content FROM clips WHERE id = ?").get(id);
    return row || null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Rows come back with tags as a JSON string; give the renderer an array. */
function hydrate(row) {
  if (!row) return row;
  let tags = [];
  if (row.tags) {
    try { tags = JSON.parse(row.tags); } catch (_) { tags = []; }
  }
  return { ...row, tags: Array.isArray(tags) ? tags : [] };
}

module.exports = { ClipDatabase, SCHEMA_VERSION };
