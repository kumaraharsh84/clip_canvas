const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "benchmark.db");
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function setupSchema() {
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO workspaces (id, name) VALUES (1, 'Test');

    CREATE TABLE boards (id INTEGER PRIMARY KEY, name TEXT);
    
    CREATE TABLE clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT DEFAULT NULL,
      source TEXT DEFAULT 'clipboard',
      tags TEXT DEFAULT '[]',
      workspace_id INTEGER DEFAULT 1,
      board_id INTEGER DEFAULT NULL,
      is_starred INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      deleted_at INTEGER DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX idx_clips_search ON clips(workspace_id, board_id, deleted_at, is_archived, content, title, tags);

    CREATE VIRTUAL TABLE clips_fts USING fts5(
      title, content, tags, source,
      content='clips', content_rowid='id'
    );
  `);
}

const words = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape", "honey", "react", "javascript", "node", "electron", "clipcanvas", "search", "fast", "slow", "performance"];
function generateContent(wordCount = 20) {
  let res = [];
  for(let i=0; i<wordCount; i++) {
    res.push(words[Math.floor(Math.random() * words.length)]);
  }
  return res.join(" ");
}

function insertClips(count) {
  const insert = db.prepare(`
    INSERT INTO clips (type, content, title, tags) VALUES (?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO clips_fts (rowid, title, content, tags, source) VALUES (?, ?, ?, ?, 'clipboard')
  `);
  
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      // 10% chance to contain 'target_keyword'
      const isTarget = Math.random() < 0.1;
      const content = generateContent(50) + (isTarget ? " target_keyword" : "");
      const res = insert.run("text", content, "Clip " + i, '["tag1"]');
      insertFts.run(res.lastInsertRowid, "Clip " + i, content, '["tag1"]');
    }
  })();
}

function measureLikeSearch(query) {
  const start = performance.now();
  const q = "%" + query + "%";
  const rows = db.prepare(`
    SELECT id FROM clips
    WHERE workspace_id = 1
      AND deleted_at IS NULL
      AND is_archived = 0
      AND (content LIKE ? OR title LIKE ? OR tags LIKE ? OR source LIKE ?)
    LIMIT 100
  `).all(q, q, q, q);
  const end = performance.now();
  return { time: end - start, count: rows.length };
}

function measureFtsSearch(query) {
  const matchTerms = query.split(/\\s+/).map(w => '"' + w + '"*').join(' AND ');
  const start = performance.now();
  const rows = db.prepare(`
    SELECT clips.id FROM clips_fts
    JOIN clips ON clips.id = clips_fts.rowid
    WHERE clips_fts MATCH ?
      AND clips.workspace_id = 1
      AND clips.deleted_at IS NULL
      AND clips.is_archived = 0
    ORDER BY clips_fts.rank
    LIMIT 100
  `).all(matchTerms);
  const end = performance.now();
  return { time: end - start, count: rows.length };
}

async function runBenchmarks() {
  setupSchema();
  
  const sizes = [100, 900, 9000]; // Total 100, 1000, 10000 iteratively
  let currentTotal = 0;
  
  console.log("| Clip Count | LIKE Search (ms) | FTS5 Search (ms) | Speedup |");
  console.log("|------------|------------------|------------------|---------|");
  
  for (const addCount of sizes) {
    insertClips(addCount);
    currentTotal += addCount;
    
    // Warm up
    measureLikeSearch("test");
    measureFtsSearch("test");
    
    let likeTotal = 0;
    let ftsTotal = 0;
    const iters = 10;
    
    for (let i = 0; i < iters; i++) {
      likeTotal += measureLikeSearch("target_keyword").time;
      ftsTotal += measureFtsSearch("target_keyword").time;
    }
    
    const likeAvg = (likeTotal / iters).toFixed(2);
    const ftsAvg = (ftsTotal / iters).toFixed(2);
    const speedup = ftsAvg > 0 ? (likeAvg / ftsAvg).toFixed(1) : "N/A";
    
    console.log("| " + currentTotal + " | " + likeAvg + " | " + ftsAvg + " | " + speedup + "x |");
  }
}

runBenchmarks().then(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});
