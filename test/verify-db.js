// ─── test/verify-db.js ────────────────────────────────────────────────────
// Checks for src/main/db.js: the v6 migration, and the queries the Time Canvas
// loads through.
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

function run() {
  // ── 1. The cap keeps the newest clips ─────────────────────────────────────
  console.log("\n-- getClips over its cap --");
  {
    const db = fresh("cap");
    const ws = db.listWorkspaces()[0].id;
    for (let i = 1; i <= 25; i++) {
      const c = db.addClip({ type: "text", content: "clip " + i, workspace_id: ws });
      at(db, c.id, new Date(2026, 0, 1, 9, i));
    }
    const got = db.getClips({ workspaceId: ws, max: 20 }).map((c) => Number(c.content.slice(5)));
    ok("the newest clip is included", got.includes(25), `got #${got[0]}..#${got[got.length - 1]}`);
    ok("the oldest are the ones dropped", !got.includes(5) && got.includes(6));
    ok("still returned oldest first", got.every((v, i) => i === 0 || v > got[i - 1]));
    db.close();
  }

  // ── 1b. Exactly one default workspace ─────────────────────────────────────
  console.log("\n-- default workspace --");
  {
    const p = path.join(TMP, "defaults.db");
    const store = path.join(TMP, "defaults-storage");
    let db = new ClipDatabase(p, store);
    db.db.prepare("UPDATE workspaces SET is_default = 1").run(); // as the first seed left them
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
      DELETE FROM schema_version WHERE version = 6;
    `);
    db.close();

    const db2 = new ClipDatabase(p, path.join(TMP, "v5-storage"));
    const trig = db2.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'clips_au'").get().sql;
    ok("update trigger now fires only on indexed columns", /AFTER\s+UPDATE\s+OF/i.test(trig));
    const missing = db2.db.prepare("SELECT COUNT(*) n FROM clips WHERE category IS NULL OR category_v <> ?").get(CLASSIFIER_VERSION).n;
    ok("every clip got a category", missing === 0, `${missing} missing`);
    ok("schema version 6 recorded", !!db2.db.prepare("SELECT 1 FROM schema_version WHERE version = 6").get());

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
    db.close();
  }

  // ── 5. Optional: a copy of the real database ──────────────────────────────
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
