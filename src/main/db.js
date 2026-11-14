// ─── src/main/db.js ──────────────────────────────────────────────────────────
// SQLite data layer for ClipCanvas, on better-sqlite3 (synchronous by design --
// every call here runs in the main process and finishes before it returns).
//
// Migrations are additive (see migrate), so a database made by any earlier
// version opens in place. test/verify-db.js checks this class.
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
//
// AND ONE THAT ONLY BITES ONCE THE HISTORY IS LARGE
//
// 3. Most columns sit AFTER `content` in a row. To read one of them from the
//    table SQLite walks that clip's text first, overflow pages and all, so a
//    query that touches every clip reads the whole database. Anything that
//    runs on every copy or every frame must be answered from an index that
//    holds all the columns it reads, or must look at a handful of rows.
//    Measured at 30,000 clips (136 MB): 300-1,700 ms from the table, 2-20 ms
//    the other way. See getDayCounts, getClipsForDays, findRecentDuplicate
//    and getStorageStats.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { categorize, CLASSIFIER_VERSION } = require("./classifyText");

const SCHEMA_VERSION = 8;
const SEARCH_LIMIT_MAX = 200;       // results per search
const SEARCH_RECENT_MATCHES = 1000; // a query matching more clips than this is ranked among its newest
const DAY_REQUEST_MAX_DAYS = 400;     // days per getClipsForDays call
const DAY_REQUEST_MAX_CLIPS = 20000;  // clips per getClipsForDays call
const RECENT_ROWS = 16;               // newest rows findRecentDuplicate looks at

// Rebuilds a clip's search entry. Only on the columns the index reads: an
// unqualified AFTER UPDATE fired on every star, pin, archive and category
// write, deleting and re-inserting the clip's whole text into the index.
const FTS_UPDATE_TRIGGER = `
  CREATE TRIGGER clips_au AFTER UPDATE OF title, content, tags, source, type ON clips BEGIN
    INSERT INTO clips_fts(clips_fts, rowid, title, content, tags, source)
    VALUES ('delete', old.id, old.title,
            CASE WHEN old.type = 'image' THEN '' ELSE old.content END,
            old.tags, old.source);
    INSERT INTO clips_fts(rowid, title, content, tags, source)
    VALUES (new.id, new.title,
            CASE WHEN new.type = 'image' THEN '' ELSE new.content END,
            new.tags, new.source);
  END;`;

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
    // v6: the canvas category ("js", "prose", ...), and the classifier version
    // that produced it -- see backfillCategories().
    addColumn("clips", "category", "TEXT DEFAULT NULL");
    addColumn("clips", "category_v", "INTEGER NOT NULL DEFAULT 0");

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
      CREATE INDEX IF NOT EXISTS idx_clips_day_counts
        ON clips(workspace_id, deleted_at, is_archived, year, month, day,
                 category, type, created_at, updated_at);
    `);
    // v7: idx_clips_day_counts holds every column getDayCounts reads, so the
    // counts never touch the table. It replaces idx_clips_day_category, which
    // had the same leading columns but not the times.
    db.exec("DROP INDEX IF EXISTS idx_clips_day_category");

    // v8: stored images (images.js). Both are partial indexes, so they hold
    // image rows only: one finds a picture already stored by its pixels, the
    // other lists the images whose thumbnail has not been decided yet and
    // empties itself as they are.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_clips_asset_hash
        ON clips(asset_hash, asset_path, thumbnail_path) WHERE asset_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_clips_thumb_todo
        ON clips(id, asset_path)
        WHERE type = 'image' AND asset_path IS NOT NULL AND thumbnail_path IS NULL;
    `);

    // v8 as well: getDayCounts under the Starred and Pinned filters. Those two
    // columns are not in idx_clips_day_counts, so the counts fell back to the
    // table. Partial again -- only starred or pinned clips are in them.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_clips_starred_days
        ON clips(workspace_id, year, month, day, category, type,
                 created_at, updated_at, deleted_at, is_starred)
        WHERE is_starred = 1;
      CREATE INDEX IF NOT EXISTS idx_clips_pinned_days
        ON clips(workspace_id, year, month, day, category, type,
                 created_at, updated_at, deleted_at, is_pinned)
        WHERE is_pinned = 1;
    `);

    this.migrateFts();
    this.backfillTimeColumns();
    this.backfillCategories();
    this.oneDefaultWorkspace();

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
    if (exists) {
      // Databases from before v6 have the unqualified update trigger.
      const au = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='clips_au'").get();
      if (!au || !/AFTER\s+UPDATE\s+OF\b/i.test(au.sql)) {
        db.transaction(() => {
          db.exec("DROP TRIGGER IF EXISTS clips_au");
          db.exec(FTS_UPDATE_TRIGGER);
        })();
      }
      return;
    }

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
    `);
    db.exec(FTS_UPDATE_TRIGGER);
    db.exec("INSERT INTO clips_fts(clips_fts) VALUES('rebuild')");
  }

  /**
   * Store the canvas category of every clip whose stored one is missing or
   * came from an older classifier. Batched, so a large history is never held
   * in memory at once. On a normal startup it finds nothing, for the cost of
   * one table scan.
   */
  backfillCategories() {
    const pick = this.db.prepare(
      "SELECT id, type, content FROM clips WHERE category_v IS NOT ? ORDER BY id LIMIT 500"
    );
    const put = this.db.prepare("UPDATE clips SET category = ?, category_v = ? WHERE id = ?");
    let updated = 0;
    for (;;) {
      const rows = pick.all(CLASSIFIER_VERSION);
      if (!rows.length) break;
      this.db.transaction(() => {
        for (const r of rows) put.run(categorize(r), CLASSIFIER_VERSION, r.id);
      })();
      updated += rows.length;
    }
    return { updated };
  }

  /**
   * Exactly one default workspace: startup captures into it. If a database
   * has several marked default, the oldest keeps the flag.
   */
  oneDefaultWorkspace() {
    this.db.prepare(`
      UPDATE workspaces SET is_default = 0
       WHERE is_default = 1
         AND id <> (SELECT MIN(id) FROM workspaces WHERE is_default = 1)
    `).run();
  }

  seed() {
    const db = this.db;
    const count = db.prepare("SELECT COUNT(*) n FROM workspaces").get().n;
    if (count > 0) return;

    // One workspace, the default: new clips go to the default workspace.
    db.prepare("INSERT INTO workspaces (name, slug, is_default) VALUES (?, ?, ?)")
      .run("Personal", "personal", 1);
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

  /**
   * Clip counts per calendar day and category -- all the Time Canvas needs to
   * draw the whole calendar without loading a single clip. `t0`/`t1` are the
   * first and last created_at of the day (Unix seconds); `v` and `dv` change
   * whenever a clip of that day is edited or trashed, so the canvas can tell
   * which loaded days are stale.
   *
   * Runs after every capture. With the default filter it is answered from
   * idx_clips_day_counts alone; a column added here must be added there.
   */
  getDayCounts(opts = {}) {
    const { sql, params } = this.clipWhere(opts);
    return this.db.prepare(`
      SELECT c.year AS year, c.month AS month, c.day AS day,
             COALESCE(c.category, c.type) AS category,
             COUNT(*) AS n,
             MIN(c.created_at) AS t0, MAX(c.created_at) AS t1,
             MAX(COALESCE(c.updated_at, c.created_at)) AS v,
             MAX(c.deleted_at) AS dv
        FROM clips c ${sql} ${sql ? "AND" : "WHERE"} c.year IS NOT NULL
       GROUP BY c.year, c.month, c.day, category
    `).all(...params);
  }

  /**
   * Full clips for a list of calendar days: `opts.days` is [{year, month, day}].
   * Answers per day, and only whole days -- a day that would push the reply
   * past DAY_REQUEST_MAX_CLIPS is left out rather than half-loaded, and the
   * canvas asks for it again later.
   */
  getClipsForDays(opts = {}) {
    const days = (Array.isArray(opts.days) ? opts.days : []).slice(0, DAY_REQUEST_MAX_DAYS);
    const { sql, params } = this.clipWhere(opts);
    const count = this.db.prepare(
      `SELECT COUNT(*) AS n FROM clips c ${sql} ${sql ? "AND" : "WHERE"} c.year = ? AND c.month = ? AND c.day = ?`
    );
    // "+c.created_at": sort the day's rows, do not walk an index in time
    // order. Without the + the planner takes idx_clips_range_query to get the
    // order for free, and then tests every clip of the workspace for the day.
    const rows = this.db.prepare(`
      SELECT c.* FROM clips c ${sql} ${sql ? "AND" : "WHERE"} c.year = ? AND c.month = ? AND c.day = ?
       ORDER BY +c.created_at ASC, c.id ASC
       LIMIT ?
    `);

    const out = [];
    let budget = DAY_REQUEST_MAX_CLIPS;
    for (const d of days) {
      const y = Number(d.year), m = Number(d.month), dd = Number(d.day);
      const n = count.get(...params, y, m, dd).n;
      // One pathological day bigger than the whole budget still loads, capped,
      // so it can never be skipped forever.
      if (n > budget && out.length) continue;
      const clips = rows.all(...params, y, m, dd, DAY_REQUEST_MAX_CLIPS).map(hydrate);
      out.push({ year: y, month: m, day: dd, clips, truncated: clips.length < n });
      budget -= clips.length;
    }
    return out;
  }

  getClipById(id) {
    const row = this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  /**
   * Full-text search, best matches first, at most SEARCH_LIMIT_MAX of them.
   *
   * A broad query -- "t", "the" -- matches most of the history, and ranking
   * means scoring every match: a second per keystroke at 30,000 clips. So
   * when a query matches more than SEARCH_RECENT_MATCHES clips, only the
   * newest that many are ranked. A query that matches fewer is ranked in
   * full. Either way the cost does not grow with the history.
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
      const match = ftsQuery(raw);
      // The id of the SEARCH_RECENT_MATCHES-th newest match, if there are that
      // many. fts5 walks matches in id order without scoring them, so this
      // stops early.
      const oldest = this.db.prepare(`
        SELECT rowid FROM clips_fts WHERE clips_fts MATCH ?
         ORDER BY rowid DESC LIMIT 1 OFFSET ${SEARCH_RECENT_MATCHES - 1}
      `).get(match);
      const ranked = this.db.prepare(`
        SELECT c.*, bm25(clips_fts) AS rank
          FROM clips_fts
          JOIN clips c ON c.id = clips_fts.rowid
         WHERE clips_fts MATCH ? AND clips_fts.rowid >= ?
           AND ${where.join(" AND ")}
         ORDER BY rank
         LIMIT ?
      `);
      const from = oldest ? oldest.rowid : 0;
      const rows = ranked.all(match, from, ...params, limit);
      // The newest matches may mostly be in Trash or another workspace. If
      // the filters left too few, rank everything after all.
      const all = from > 0 && rows.length < limit ? ranked.all(match, 0, ...params, limit) : rows;
      return all.map(hydrate);
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

  // ── Time columns ───────────────────────────────────────────────────────────
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
        created_at, updated_at, year, month, day, weekday, hour,
        category, category_v
      ) VALUES (
        @type, @content, @title, @file_size_bytes, @source, @tags,
        @workspace_id, @board_id, @storage_mode, @asset_path, @asset_hash,
        @thumbnail_path, @original_path, @mime_type,
        @created_at, @updated_at, @year, @month, @day, @weekday, @hour,
        @category, @category_v
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
      category: categorize(clip),
      category_v: CLASSIFIER_VERSION,
    });

    return this.getClipById(info.lastInsertRowid);
  }

  /**
   * Has this exact content already been captured in the last few seconds?
   * Runs on every text copy, so it looks only at the newest rows: ids grow
   * with time, and a clip from the last 3 seconds is among them. Comparing
   * `content` across the table read every clip.
   */
  findRecentDuplicate(workspaceId, type, content, withinSeconds = 3) {
    if (content == null) return null;
    return this.db.prepare(`
      SELECT id FROM clips
       WHERE id IN (SELECT id FROM clips ORDER BY id DESC LIMIT ${RECENT_ROWS})
         AND workspace_id IS ? AND type = ? AND content = ?
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

  getTrashSummary({ workspaceId } = {}) {
    const where = "WHERE deleted_at IS NOT NULL" + (workspaceId ? " AND workspace_id = ?" : "");
    const params = workspaceId ? [workspaceId] : [];
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(file_size_bytes),0) AS bytes,
              MIN(deleted_at) AS oldest FROM clips ${where}`
    ).get(...params);
    return { count: row.count, bytes: row.bytes, oldest: row.oldest };
  }

  /**
   * Permanently remove trashed rows, then the files only they used. A picture
   * can belong to several clips (images.js stores identical ones once), so a
   * file goes only when no remaining clip points at it. Removal is
   * best-effort: a missing or locked file is left behind, never the row.
   */
  emptyTrash({ workspaceId } = {}) {
    const where = "WHERE deleted_at IS NOT NULL" + (workspaceId ? " AND workspace_id = ?" : "");
    const params = workspaceId ? [workspaceId] : [];
    const rows = this.db.prepare(
      `SELECT asset_path, thumbnail_path, asset_hash FROM clips ${where}`
    ).all(...params);
    const info = this.db.prepare(`DELETE FROM clips ${where}`).run(...params);

    // Clips share a file only when they share its hash, so the index on
    // asset_hash answers "does anyone still use it" without reading the table.
    const stillUsed = this.db.prepare(
      "SELECT 1 FROM clips WHERE asset_hash = ? AND (asset_path = ? OR thumbnail_path = ?) LIMIT 1"
    );
    const done = new Set();
    let filesRemoved = 0;
    for (const r of rows) {
      for (const rel of [r.asset_path, r.thumbnail_path]) {
        if (!rel || done.has(rel)) continue;
        done.add(rel);
        if (r.asset_hash && stillUsed.get(r.asset_hash, rel, rel)) continue;
        try { fs.unlinkSync(path.join(this.storageDir, rel)); filesRemoved++; } catch (_) {}
      }
    }
    return { removed: info.changes, filesRemoved };
  }

  // ── Stored images (images.js) ──────────────────────────────────────────────
  /** A stored picture with these pixels, newest first, or null. */
  findImageByHash(hash) {
    return this.db.prepare(`
      SELECT asset_path, thumbnail_path, file_size_bytes FROM clips
       WHERE asset_hash = ? AND asset_path IS NOT NULL
       ORDER BY id DESC LIMIT 1
    `).get(hash) || null;
  }

  /**
   * The newest image whose thumbnail has not been decided: thumbnail_path is
   * NULL. ("" means it needs none.) The WHERE must stay word for word that of
   * idx_clips_thumb_todo, or SQLite will not use it.
   */
  nextImageWithoutThumbnail() {
    return this.db.prepare(`
      SELECT id, asset_path FROM clips
       WHERE type = 'image' AND asset_path IS NOT NULL AND thumbnail_path IS NULL
       ORDER BY id DESC LIMIT 1
    `).get() || null;
  }

  /**
   * Record a thumbnail ("" for none). updated_at is left alone on purpose: the
   * clip itself did not change, and its day need not be loaded again.
   */
  setThumbnail(id, rel) {
    this.db.prepare("UPDATE clips SET thumbnail_path = ? WHERE id = ?").run(rel, id);
  }

  // ── Storage figures ────────────────────────────────────────────────────────
  /**
   * What the Settings window shows: how many clips, how many of them are
   * images, and how much room the images and the database take. Clips in
   * Trash are not counted. Answered from idx_clips_storage alone, so it never
   * reads a clip's text.
   * @returns {{clips: number, images: number, imageBytes: number, dbBytes: number}}
   */
  getStorageStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS clips,
             COALESCE(SUM(type = 'image'), 0) AS images,
             COALESCE(SUM(CASE WHEN type = 'image' THEN file_size_bytes END), 0) AS imageBytes
        FROM clips WHERE deleted_at IS NULL
    `).get();
    return { ...row, dbBytes: safeSize(this.dbPath) };
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

function safeSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

module.exports = { ClipDatabase, SCHEMA_VERSION, SEARCH_RECENT_MATCHES, ftsQuery };
