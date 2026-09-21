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
const SEARCH_LIMIT_MAX = 200; // matches the clamp the old searchClips applied

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

    this.migrateFts();

    const have = db.prepare("SELECT version FROM schema_version WHERE version = ?");
    const mark = db.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)");
    for (let v = 1; v <= SCHEMA_VERSION; v++) if (!have.get(v)) mark.run(v);
  }

  /**
   * fts5 with content='clips' keeps no copy of the text: it indexes the base
   * table by rowid and the triggers keep it in step. Image clips are indexed
   * with an empty body so base64 payloads never enter the index.
   */
  migrateFts() {
    const db = this.db;
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clips_fts'")
      .get();
    if (exists) return;

    db.exec(`
      CREATE VIRTUAL TABLE clips_fts USING fts5(
        title, content, tags, source,
        content='clips', content_rowid='id'
      );

      CREATE TRIGGER clips_ai AFTER INSERT ON clips BEGIN
        INSERT INTO clips_fts(rowid, title, content, tags, source)
        VALUES (new.id, new.title,
                CASE WHEN new.type = 'image' THEN '' ELSE new.content END,
                new.tags, new.source);
      END;

      CREATE TRIGGER clips_ad AFTER DELETE ON clips BEGIN
        INSERT INTO clips_fts(clips_fts, rowid, title, content, tags, source)
        VALUES ('delete', old.id, old.title,
                CASE WHEN old.type = 'image' THEN '' ELSE old.content END,
                old.tags, old.source);
      END;

      CREATE TRIGGER clips_au AFTER UPDATE ON clips BEGIN
        INSERT INTO clips_fts(clips_fts, rowid, title, content, tags, source)
        VALUES ('delete', old.id, old.title,
                CASE WHEN old.type = 'image' THEN '' ELSE old.content END,
                old.tags, old.source);
        INSERT INTO clips_fts(rowid, title, content, tags, source)
        VALUES (new.id, new.title,
                CASE WHEN new.type = 'image' THEN '' ELSE new.content END,
                new.tags, new.source);
      END;
    `);
    db.exec("INSERT INTO clips_fts(clips_fts) VALUES('rebuild')");
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

  // ── Search ─────────────────────────────────────────────────────────────────
  /**
   * FTS5 search. The limit is clamped to 200, which benchmark-renderer.js notes
   * as the behaviour the June baseline predates -- keep it, the renderer's
   * result list is built around it.
   */
  searchClips(opts = {}) {
    const raw = String(opts.query || opts.q || "").trim();
    if (!raw) return [];
    const limit = Math.min(Number(opts.limit) || SEARCH_LIMIT_MAX, SEARCH_LIMIT_MAX);

    const where = ["c.deleted_at IS NULL"];
    const params = [];
    if (opts.workspaceId) { where.push("c.workspace_id = ?"); params.push(opts.workspaceId); }
    if (opts.boardId) { where.push("c.board_id = ?"); params.push(opts.boardId); }
    if (!opts.includeArchived) where.push("c.is_archived = 0");

    try {
      return this.db.prepare(`
        SELECT c.*, bm25(clips_fts) AS rank
          FROM clips_fts
          JOIN clips c ON c.id = clips_fts.rowid
         WHERE clips_fts MATCH ?
           AND ${where.join(" AND ")}
         ORDER BY rank
         LIMIT ?
      `).all(ftsQuery(raw), ...params, limit).map(hydrate);
    } catch (err) {
      // A bare LIKE fallback, because fts5 MATCH throws on malformed queries
      // (an unbalanced quote, a lone NEAR) and a search box should never be
      // able to crash the app by what someone typed into it.
      const like = "%" + raw.replace(/[%_]/g, "") + "%";
      return this.db.prepare(`
        SELECT c.* FROM clips c
         WHERE ${where.join(" AND ")}
           AND (c.content LIKE ? OR c.title LIKE ? OR c.tags LIKE ?)
         ORDER BY c.created_at DESC
         LIMIT ?
      `).all(...params, like, like, like, limit).map(hydrate);
    }
  }

  // ── Time hierarchy (Time Canvas) ───────────────────────────────────────────
  timeBase(workspaceId) {
    return {
      sql: "WHERE deleted_at IS NULL AND is_archived = 0" +
           (workspaceId ? " AND workspace_id = ?" : ""),
      params: workspaceId ? [workspaceId] : [],
    };
  }

  getYears(workspaceId) {
    const b = this.timeBase(workspaceId);
    return this.db.prepare(
      `SELECT year, COUNT(*) AS count FROM clips ${b.sql} AND year IS NOT NULL
       GROUP BY year ORDER BY year ASC`
    ).all(...b.params);
  }

  getMonths(year, workspaceId) {
    const b = this.timeBase(workspaceId);
    return this.db.prepare(
      `SELECT month, COUNT(*) AS count FROM clips ${b.sql} AND year = ?
       GROUP BY month ORDER BY month ASC`
    ).all(...b.params, year);
  }

  getDays(year, month, workspaceId) {
    const b = this.timeBase(workspaceId);
    return this.db.prepare(
      `SELECT day, COUNT(*) AS count FROM clips ${b.sql} AND year = ? AND month = ?
       GROUP BY day ORDER BY day ASC`
    ).all(...b.params, year, month);
  }

  getHours(year, month, day, workspaceId) {
    const b = this.timeBase(workspaceId);
    return this.db.prepare(
      `SELECT hour, COUNT(*) AS count FROM clips ${b.sql}
         AND year = ? AND month = ? AND day = ?
       GROUP BY hour ORDER BY hour ASC`
    ).all(...b.params, year, month, day);
  }

  /** `startTimestamp`/`endTimestamp` are Unix SECONDS, matching created_at. */
  getClipsInTimeRange(startTimestamp, endTimestamp, workspaceId) {
    const b = this.timeBase(workspaceId);
    return this.db.prepare(
      `SELECT * FROM clips ${b.sql} AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`
    ).all(...b.params, toSeconds(startTimestamp), toSeconds(endTimestamp)).map(hydrate);
  }

  /** Split a range into working sessions separated by a gap of idle minutes. */
  getSessions(startTimestamp, endTimestamp, workspaceId, gapMinutes = 30) {
    const clips = this.getClipsInTimeRange(startTimestamp, endTimestamp, workspaceId);
    const gap = Math.max(1, Number(gapMinutes) || 30) * 60;
    const sessions = [];
    let cur = null;

    for (const c of clips) {
      if (!cur || c.created_at - cur.end > gap) {
        cur = { start: c.created_at, end: c.created_at, count: 0, clips: [] };
        sessions.push(cur);
      }
      cur.end = c.created_at;
      cur.count++;
      cur.clips.push(c.id);
    }
    return sessions;
  }

  /**
   * Fill year/month/day/weekday/hour for rows where they are NULL.
   * SQLite's strftime is used rather than JS so the whole thing is one
   * statement; '%s' values are seconds, hence the 'unixepoch' modifier.
   */
  backfillTimeColumns() {
    const info = this.db.prepare(`
      UPDATE clips SET
        year    = CAST(strftime('%Y', created_at, 'unixepoch', 'localtime') AS INTEGER),
        month   = CAST(strftime('%m', created_at, 'unixepoch', 'localtime') AS INTEGER),
        day     = CAST(strftime('%d', created_at, 'unixepoch', 'localtime') AS INTEGER),
        weekday = CAST(strftime('%w', created_at, 'unixepoch', 'localtime') AS INTEGER),
        hour    = CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER)
      WHERE year IS NULL OR month IS NULL OR day IS NULL OR hour IS NULL
    `).run();
    return { updated: info.changes };
  }

  // ── Writing clips ──────────────────────────────────────────────────────────
  addClip(clip) {
    const now = Math.floor(Date.now() / 1000);
    const d = new Date(now * 1000);

    const info = this.db.prepare(`
      INSERT INTO clips (
        type, content, title, file_size_bytes, source, tags,
        workspace_id, board_id, storage_mode, asset_path, asset_hash,
        thumbnail_path, original_path, mime_type,
        created_at, updated_at, year, month, day, weekday, hour
      ) VALUES (
        @type, @content, @title, @file_size_bytes, @source, @tags,
        @workspace_id, @board_id, @storage_mode, @asset_path, @asset_hash,
        @thumbnail_path, @original_path, @mime_type,
        @created_at, @updated_at, @year, @month, @day, @weekday, @hour
      )
    `).run({
      type: clip.type,
      content: clip.content ?? null,
      title: clip.title ?? null,
      file_size_bytes: clip.file_size_bytes ?? (clip.content ? Buffer.byteLength(clip.content) : 0),
      source: clip.source ?? "clipboard",
      tags: JSON.stringify(clip.tags ?? autoTags(clip)),
      workspace_id: clip.workspace_id ?? null,
      board_id: clip.board_id ?? null,
      storage_mode: clip.storage_mode ?? "inline",
      asset_path: clip.asset_path ?? null,
      asset_hash: clip.asset_hash ?? null,
      thumbnail_path: clip.thumbnail_path ?? null,
      original_path: clip.original_path ?? null,
      mime_type: clip.mime_type ?? null,
      created_at: now,
      updated_at: now,
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      weekday: d.getDay(), hour: d.getHours(),
    });

    return this.getClipById(info.lastInsertRowid);
  }

  /** Has this exact content already been captured recently? */
  findRecentDuplicate(workspaceId, type, content, withinSeconds = 3) {
    if (content == null) return null;
    return this.db.prepare(`
      SELECT id FROM clips
       WHERE workspace_id IS ? AND type = ? AND content = ?
         AND created_at >= strftime('%s','now') - ?
       LIMIT 1
    `).get(workspaceId ?? null, type, content, withinSeconds);
  }

  updateClip(id, patch = {}) {
    const allowed = ["title", "tags", "workspace_id", "board_id",
                     "is_starred", "is_archived", "is_pinned",
                     "canvas_x", "canvas_y", "pos_x", "pos_y", "is_free_position"];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(key === "tags" && typeof patch[key] !== "string"
        ? JSON.stringify(patch[key]) : patch[key]);
    }
    if (!sets.length) return this.getClipById(id);
    sets.push("updated_at = strftime('%s','now')");
    this.db.prepare(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return this.getClipById(id);
  }

  /** Archive never touches a starred clip -- stated behaviour in the README. */
  archiveClips(ids) {
    const stmt = this.db.prepare(
      "UPDATE clips SET is_archived = 1, updated_at = strftime('%s','now') WHERE id = ? AND is_starred = 0"
    );
    let n = 0;
    this.db.transaction(() => { for (const id of ids) n += stmt.run(id).changes; })();
    return { archived: n };
  }

  /** Soft delete -> Trash. */
  deleteClips(ids) {
    const stmt = this.db.prepare(
      "UPDATE clips SET deleted_at = strftime('%s','now') WHERE id = ? AND deleted_at IS NULL"
    );
    let n = 0;
    this.db.transaction(() => { for (const id of ids) n += stmt.run(id).changes; })();
    return { deleted: n };
  }

  restoreClips(ids) {
    const stmt = this.db.prepare(
      "UPDATE clips SET deleted_at = NULL, updated_at = strftime('%s','now') WHERE id = ?"
    );
    let n = 0;
    this.db.transaction(() => { for (const id of ids) n += stmt.run(id).changes; })();
    return { restored: n };
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

/**
 * Turn user input into a safe fts5 query. Bare punctuation is a syntax error in
 * MATCH, so each word is quoted and the last one gets a prefix `*` so search
 * feels live as you type.
 */
function ftsQuery(raw) {
  const words = raw.split(/\s+/).filter(Boolean).map((w) => w.replace(/"/g, ""));
  if (!words.length) return '""';
  return words
    .map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`))
    .join(" AND ");
}

function autoTags(clip) {
  const tags = [clip.type];
  if (clip.type === "url" && clip.content) {
    try { tags.push(new URL(clip.content).hostname.replace(/^www\./, "")); } catch (_) {}
  }
  return tags;
}

function toSeconds(v) {
  const n = Number(v) || 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

module.exports = { ClipDatabase, SCHEMA_VERSION, ftsQuery, toSeconds };
