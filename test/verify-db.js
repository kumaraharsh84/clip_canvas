// ─── test/verify-db.js ────────────────────────────────────────────────────
// Checks for src/main/db.js: the migrations since v5, the queries the Time
// Canvas loads through, that the ones which run on every copy are answered
// from an index rather than by reading every clip, and the bookkeeping for
// stored images (one file for identical pictures, thumbnails still to make).
//
// better-sqlite3 is built for Electron's Node, so this runs under Electron:
//   npm run test:db                         (electron test/verify-db.js)
//   ELECTRON_RUN_AS_NODE=1 electron test/verify-db.js
//
// Works on throwaway databases in the OS temp folder. With --live it also
// migrates a COPY of %APPDATA%/clipcanvas/clipcanvas.db; the real file is
// never opened for writing.
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const os = require("os");

const { ClipDatabase } = require("../src/main/db");
const { categorize, CLASSIFIER_VERSION } = require("../src/main/classifyText");
const { categoryOf } = require("../src/renderer/canvas/classify");

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};
const info = (s) => console.log("       " + s);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clipcanvas-verify-db-"));
const fresh = (name) => {
  const p = path.join(TMP, name + ".db");
  return new ClipDatabase(p, path.join(TMP, name + "-storage"));
};

function at(db, id, date) {
  const s = Math.floor(date.getTime() / 1000);
  db.db.prepare(`UPDATE clips SET created_at = ?, year = ?, month = ?, day = ?, hour = ? WHERE id = ?`)
    .run(s, date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), id);
}

/**
 * The query plan of every statement `fn` makes `db` prepare -- the app's own
 * SQL, not a copy of it that could drift.
 */
function plansOf(db, fn) {
  const raw = db.db;
  const prepare = raw.prepare.bind(raw);
  const seen = [];
  raw.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  try { fn(); } finally { delete raw.prepare; }
  return seen.map((sql) => {
    const args = new Array((sql.match(/\?/g) || []).length).fill(null);
    return prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((r) => r.detail).join(" | ");
  });
}

function run() {
  // ── 1. Exactly one default workspace ─────────────────────────────────────
  console.log("\n-- default workspace --");
  {
    const p = path.join(TMP, "defaults.db");
    const store = path.join(TMP, "defaults-storage");
    let db = new ClipDatabase(p, store);
    db.createWorkspace("Archive");
    db.createWorkspace("Work");
    db.db.prepare("UPDATE workspaces SET is_default = 1").run(); // as an early seed left them
    db.close();
    db = new ClipDatabase(p, store);
    const defs = db.listWorkspaces().filter((w) => w.is_default);
    ok("an old database is left with one default workspace, Personal",
       defs.length === 1 && defs[0].name === "Personal", defs.map((w) => w.name).join(", "));
    db.close();
  }

  // ── 2. Categories are stored at capture ───────────────────────────────────
  console.log("\n-- categories --");
  const samples = [
    ["text", "Theek hai, kal subah tak bhej dunga. Pehle tests pass karwa leta hoon."],
    ["code", "const xs = items.filter((x) => x.ready);\nexport default xs;"],
    ["code", "SELECT id, name FROM users WHERE active = 1 ORDER BY name;"],
    ["url", "https://example.com/some/page"],
    ["text", "ok"],
  ];
  {
    const db = fresh("cat");
    const ws = db.listWorkspaces()[0].id;
    let agree = 0;
    for (const [type, content] of samples) {
      const c = db.addClip({ type, content, workspace_id: ws });
      if (c.category === categoryOf({ type, content }).id && c.category_v === CLASSIFIER_VERSION) agree++;
    }
    ok("stored category = the category the canvas shows", agree === samples.length, `${agree}/${samples.length}`);
    db.close();
  }

  // ── 3. Migrating a v5 database ─────────────────────────────────────────────
  // Build one the way v5 left it: no category columns, and the FTS update
  // trigger that fires on every column.
  console.log("\n-- migrating a v5 database --");
  {
    const p = path.join(TMP, "v5.db");
    const db = new ClipDatabase(p, path.join(TMP, "v5-storage"));
    const ws = db.listWorkspaces()[0].id;
    for (const [type, content] of samples) db.addClip({ type, content, workspace_id: ws });
    db.db.exec(`
      DROP TRIGGER clips_au;
      CREATE TRIGGER clips_au AFTER UPDATE ON clips BEGIN
        INSERT INTO clips_fts(clips_fts, rowid, title, content, tags, source)
        VALUES ('delete', old.id, old.title, CASE WHEN old.type = 'image' THEN '' ELSE old.content END, old.tags, old.source);
        INSERT INTO clips_fts(rowid, title, content, tags, source)
        VALUES (new.id, new.title, CASE WHEN new.type = 'image' THEN '' ELSE new.content END, new.tags, new.source);
      END;
      UPDATE clips SET category = NULL, category_v = 0;
      DROP INDEX idx_clips_day_counts;
      CREATE INDEX idx_clips_day_category
        ON clips(workspace_id, deleted_at, is_archived, year, month, day, category);
      DELETE FROM schema_version WHERE version >= 6;
    `);
    db.close();

    const db2 = new ClipDatabase(p, path.join(TMP, "v5-storage"));
    const trig = db2.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'clips_au'").get().sql;
    ok("update trigger now fires only on indexed columns", /AFTER\s+UPDATE\s+OF/i.test(trig));
    const missing = db2.db.prepare("SELECT COUNT(*) n FROM clips WHERE category IS NULL OR category_v <> ?").get(CLASSIFIER_VERSION).n;
    ok("every clip got a category", missing === 0, `${missing} missing`);
    ok("schema versions 6, 7 and 8 recorded",
       db2.db.prepare("SELECT COUNT(*) n FROM schema_version WHERE version IN (6, 7, 8)").get().n === 3);
    const idx = db2.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_clips_day_%'").all().map((r) => r.name);
    ok("the day-count index replaced the older one", idx.join() === "idx_clips_day_counts", idx.join(", "));

    // Search still follows edits after the trigger change -- and a star does
    // not duplicate the clip in the index.
    const id = db2.searchClips({ query: "tests", workspaceId: ws })[0].id;
    db2.updateClip(id, { is_starred: 1 });
    ok("a starred clip is found once", db2.searchClips({ query: "tests", workspaceId: ws }).length === 1);
    db2.updateClip(id, { title: "zebracorn" });
    ok("a title edit is searchable", db2.searchClips({ query: "zebracorn", workspaceId: ws }).length === 1);
    db2.close();
  }

  // ── 4. Day counts and day loading ─────────────────────────────────────────
  console.log("\n-- per-day queries --");
  {
    const db = fresh("days");
    const ws = db.listWorkspaces()[0].id;
    const plan = [[3, 9, "text", "a note about lunch plans for the team today"], [3, 9, "code", "const a = 1;\nlet b = a + 2;"],
                  [3, 14, "url", "https://example.com"], [4, 10, "text", "hi"], [7, 22, "code", "SELECT 1 FROM t WHERE x = 2;"]];
    for (const [day, hour, type, content] of plan) {
      const c = db.addClip({ type, content, workspace_id: ws });
      at(db, c.id, new Date(2026, 5, day, hour, 30));
    }
    const rows = db.getDayCounts({ workspaceId: ws });
    const byDay = {};
    for (const r of rows) byDay[r.day] = (byDay[r.day] || 0) + r.n;
    ok("counts per day", byDay[3] === 3 && byDay[4] === 1 && byDay[7] === 1, JSON.stringify(byDay));
    ok("counts split by category", rows.filter((r) => r.day === 3).length === 3);
    ok("first/last time of the day", rows.every((r) => r.t0 <= r.t1));

    const res = db.getClipsForDays({ workspaceId: ws, days: [{ year: 2026, month: 6, day: 3 }, { year: 2026, month: 6, day: 7 }] });
    ok("whole days come back, in order", res.length === 2 && res[0].clips.length === 3 && res[1].clips.length === 1 &&
       res[0].clips.every((c, i, a) => i === 0 || c.created_at >= a[i - 1].created_at));
    ok("full text is included", res[0].clips.some((c) => c.content === "const a = 1;\nlet b = a + 2;"));

    const before = rows.find((r) => r.day === 4);
    const id = res[0].clips[0].id;
    db.deleteClips([id]);
    const after = db.getDayCounts({ workspaceId: ws }).filter((r) => r.day === 3).reduce((s, r) => s + r.n, 0);
    ok("trashing a clip changes its day's count", after === 2);
    ok("trash filter sees it", db.getDayCounts({ workspaceId: ws, filter: "trash" }).some((r) => r.day === 3));
    void before;

    // Both run constantly: the counts after every copy, a day's clips for
    // every day that scrolls into view.
    const counts = plansOf(db, () => db.getDayCounts({ workspaceId: ws }));
    ok("day counts are answered from an index alone",
       counts.length === 1 && /COVERING INDEX idx_clips_day_counts/.test(counts[0]), counts.join(" || "));
    for (const filter of ["starred", "pinned", "archived", "all"]) {
      const p = plansOf(db, () => db.getDayCounts({ workspaceId: ws, filter }));
      ok(`and under the ${filter} filter`, p.length === 1 && /COVERING INDEX/.test(p[0]), p.join(" || "));
    }
    const dayPlans = plansOf(db, () => db.getClipsForDays({ workspaceId: ws, days: [{ year: 2026, month: 6, day: 3 }] }));
    ok("a day's clips are found by their day, not by scanning time",
       dayPlans.length === 2 && dayPlans.every((p) => /day=\?/.test(p)), dayPlans.join(" || "));
    db.close();
  }

  // ── 5. Storage figures and the duplicate check ────────────────────────────
  console.log("\n-- storage figures and the duplicate check --");
  {
    const db = fresh("stats");
    const ws = db.listWorkspaces()[0].id;
    const note = db.addClip({ type: "text", content: "first note", workspace_id: ws });
    db.addClip({ type: "image", content: null, workspace_id: ws, file_size_bytes: 1000 });
    db.addClip({ type: "image", content: null, workspace_id: ws, file_size_bytes: 500 });
    const gone = db.addClip({ type: "image", content: null, workspace_id: ws, file_size_bytes: 9999 });
    db.deleteClips([gone.id]);

    const s = db.getStorageStats();
    ok("storage figures count clips and images, and leave out Trash",
       s.clips === 3 && s.images === 2 && s.imageBytes === 1500 && s.dbBytes > 0, JSON.stringify(s));
    const statPlans = plansOf(db, () => db.getStorageStats());
    ok("storage figures are answered from an index alone",
       statPlans.length === 1 && /COVERING INDEX/.test(statPlans[0]), statPlans.join(" || "));

    ok("the same text copied again at once is a duplicate", !!db.findRecentDuplicate(ws, "text", "first note"));
    ok("different text is not", !db.findRecentDuplicate(ws, "text", "second note"));
    ok("nor the same text in another workspace", !db.findRecentDuplicate(ws + 1000, "text", "first note"));
    for (let i = 0; i < 40; i++) db.addClip({ type: "text", content: "filler " + i, workspace_id: ws });
    ok("nor the same text once many copies have followed it", !db.findRecentDuplicate(ws, "text", "first note"));
    const again = db.addClip({ type: "text", content: "first note", workspace_id: ws });
    ok("a fresh copy of it is a duplicate again", !!db.findRecentDuplicate(ws, "text", "first note"));
    at(db, again.id, new Date(Date.now() - 60000));
    ok("but not a minute later", !db.findRecentDuplicate(ws, "text", "first note"));
    void note;
    db.close();
  }

  // ── 6. Stored images ──────────────────────────────────────────────────────
  console.log("\n-- stored images --");
  {
    const db = fresh("images");
    const ws = db.listWorkspaces()[0].id;
    const store = path.join(TMP, "images-storage");
    const on = (rel) => fs.existsSync(path.join(store, rel));
    const put = (rel) => {
      fs.mkdirSync(path.dirname(path.join(store, rel)), { recursive: true });
      fs.writeFileSync(path.join(store, rel), "x");
    };
    const image = (hash, rel, thumb) => db.addClip({
      type: "image", content: null, workspace_id: ws, asset_hash: hash,
      asset_path: rel, thumbnail_path: thumb, file_size_bytes: 10,
    });
    for (const rel of ["images/a.png", "thumbs/a.png", "images/b.png"]) put(rel);
    const a1 = image("hash-a", "images/a.png", "thumbs/a.png");
    const a2 = image("hash-a", "images/a.png", "thumbs/a.png");
    const b = image("hash-b", "images/b.png", null);

    const twin = db.findImageByHash("hash-a");
    ok("a stored picture is found by its pixels",
       !!twin && twin.asset_path === "images/a.png" && twin.thumbnail_path === "thumbs/a.png", JSON.stringify(twin));
    ok("an unknown picture is not", db.findImageByHash("hash-z") === null);
    const twinPlan = plansOf(db, () => db.findImageByHash("hash-a"));
    ok("found through the hash index", /idx_clips_asset_hash/.test(twinPlan[0]), twinPlan[0]);

    const sig = () => JSON.stringify(db.getDayCounts({ workspaceId: ws }).map((r) => [r.n, r.v, r.dv]));
    const before = sig();
    const next = db.nextImageWithoutThumbnail();
    ok("the image with no thumbnail yet is next in line", !!next && next.id === b.id);
    const todoPlan = plansOf(db, () => db.nextImageWithoutThumbnail());
    ok("found through the to-do index", /idx_clips_thumb_todo/.test(todoPlan[0]), todoPlan[0]);
    db.setThumbnail(b.id, "");
    ok("once decided -- even as 'needs none' -- it is not", db.nextImageWithoutThumbnail() === null);
    ok("recording a thumbnail does not mark the day as changed", sig() === before);

    db.deleteClips([a1.id, b.id]);
    const first = db.emptyTrash({ workspaceId: ws });
    ok("emptying Trash keeps a picture another clip still uses",
       on("images/a.png") && on("thumbs/a.png") && !on("images/b.png") && first.removed === 2, JSON.stringify(first));
    db.deleteClips([a2.id]);
    const second = db.emptyTrash({ workspaceId: ws });
    ok("and removes it with the last clip that used it",
       !on("images/a.png") && !on("thumbs/a.png") && second.filesRemoved === 2, JSON.stringify(second));
    db.close();
  }

  // ── 7. Optional: a copy of the real database ──────────────────────────────
  if (process.argv.includes("--live")) {
    console.log("\n-- a copy of your database --");
    const appData = process.env.APPDATA || path.join(os.homedir(), ".config");
    const live = path.join(appData, "clipcanvas", "clipcanvas.db");
    if (!fs.existsSync(live)) {
      info("no database at " + live);
    } else {
      const copy = path.join(TMP, "live-copy.db");
      fs.copyFileSync(live, copy);
      for (const s of ["-wal", "-shm"]) if (fs.existsSync(live + s)) fs.copyFileSync(live + s, copy + s);
      const t0 = Date.now();
      const db = new ClipDatabase(copy, path.join(TMP, "live-storage"));
      const ms = Date.now() - t0;
      const total = db.db.prepare("SELECT COUNT(*) n FROM clips").get().n;
      const cats = db.db.prepare("SELECT category, COUNT(*) n FROM clips GROUP BY category ORDER BY n DESC").all();
      info(`${total} clips migrated in ${ms} ms: ` + cats.map((c) => `${c.category} ${c.n}`).join(", "));
      const sample = db.db.prepare("SELECT id, type, content, category FROM clips ORDER BY RANDOM() LIMIT 300").all();
      const disagree = sample.filter((r) => r.category !== categorize(r)).length;
      ok("stored categories match the classifier", disagree === 0, `${disagree}/${sample.length} disagree`);
      const days = db.getDayCounts({});
      const sum = days.reduce((s, r) => s + r.n, 0);
      const active = db.db.prepare("SELECT COUNT(*) n FROM clips WHERE deleted_at IS NULL AND is_archived = 0").get().n;
      ok("day counts add up to the active clips", sum === active, `${sum} vs ${active}`);
      db.close();
    }
  }
}

function finish() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
  return failures ? 1 : 0;
}

// Runs as an Electron app (npm run test:db) or under ELECTRON_RUN_AS_NODE.
const electron = require("electron");
if (electron && electron.app) {
  electron.app.whenReady().then(() => {
    let code = 1;
    try { run(); code = finish(); } catch (err) { console.error(err); }
    electron.app.exit(code);
  });
} else {
  let code = 1;
  try { run(); code = finish(); } catch (err) { console.error(err); }
  process.exit(code);
}
