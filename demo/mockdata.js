// ─── demo/mockdata.js ────────────────────────────────────────────────────────
// Synthetic clip rows shaped like the real `clips` table, for driving the demo
// without a database. Field names match the schema in README.md so the demo
// exercises exactly the same code path as the app.
//
// Two properties matter for what the demo shows:
//   - lengths are heavy-tailed, like real clipboard history: most clips short,
//     a few enormous -- the case per-card font fitting has to survive
//   - each code clip is ONE language, so the canvas shows the full palette the
//     way real history does (a mixed-language blob just reads as "Other code")
//   - clips cluster into working sessions, so hours are as uneven as real ones
// ─────────────────────────────────────────────────────────────────────────────

(function (global) {
  // mulberry32: deterministic, so runs are comparable. The simple LCG this
  // replaced had strongly correlated consecutive outputs -- the language pick
  // that follows the clip-type pick landed in a narrow band, and the demo never
  // produced a single SQL or HTML clip in 2,000.
  let seed = 1234567;
  function rnd() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  const WORDS = ("the quick brown fox jumps over lazy dog build deploy cache index query " +
    "renderer viewport clipboard workspace board archive session token payload buffer " +
    "migration schema column sqlite electron canvas treemap zoom layout thumbnail latency " +
    "throughput commit branch rebase resolve conflict pointer reference closure promise").split(" ");

  // One list of snippet generators per language. `n` varies the identifiers.
  const LANGS = {
    js: [
      (n) => `function ${n}(items, options) {\n  const out = [];\n  for (const it of items) {\n    if (!it.enabled) continue;\n    out.push({ id: it.id, value: it.value * options.scale });\n  }\n  return out;\n}`,
      (n) => `const ${n} = async (req, res) => {\n  try {\n    const rows = await db.all(req.params.id);\n    res.json({ success: true, data: rows });\n  } catch (err) {\n    console.error(err);\n  }\n};`,
      (n) => `export class ${n} {\n  constructor(opts) {\n    this.opts = opts;\n    this.cache = new Map();\n  }\n  get(key) {\n    // fall through to the slow path on a miss\n    return this.cache.get(key) ?? this.compute(key);\n  }\n}`,
    ],
    py: [
      (n) => `def ${n}(rows, limit=50):\n    """Keep the newest rows."""\n    out = []\n    for row in rows:\n        if row.get("deleted"):\n            continue\n        out.append(row)\n    return out[:limit]`,
      (n) => `class ${n}:\n    def __init__(self, path):\n        self.path = path\n        self.items = []\n\n    def load(self):\n        with open(self.path) as f:\n            self.items = f.read().splitlines()\n        return self`,
    ],
    sql: [
      (n) => `SELECT id, title, created_at\nFROM ${n}\nWHERE workspace_id = 1\n  AND deleted_at IS NULL\nORDER BY created_at DESC\nLIMIT 50;`,
      (n) => `CREATE TABLE IF NOT EXISTS ${n} (\n  id INTEGER PRIMARY KEY,\n  content TEXT,\n  created_at INTEGER\n);\nCREATE INDEX idx_${n}_time ON ${n}(created_at);`,
    ],
    html: [
      (n) => `<section class="${n}">\n  <header>\n    <h2>Recent clips</h2>\n  </header>\n  <ul>\n    <li><a href="#one">First</a></li>\n    <li><a href="#two">Second</a></li>\n  </ul>\n</section>`,
    ],
    css: [
      (n) => `.${n} {\n  display: grid;\n  gap: 8px;\n  color: #c9d6e0;\n  background: #0b0f14;\n}\n\n.${n}:hover {\n  border-color: #6fa8dc;\n}`,
    ],
    json: [
      (n) => `{\n  "name": "${n}",\n  "version": "1.0.${int(0, 9)}",\n  "private": true,\n  "scripts": {\n    "start": "electron .",\n    "build": "electron-builder"\n  }\n}`,
    ],
    shell: [
      (n) => `cd projects/${n}\nnpm install --save-dev electron\ngit checkout -b feature/${n}\ngit commit -am "wip"\nnpm run build && npm start`,
    ],
  };
  // How often each language turns up, roughly like a developer's history.
  const LANG_MIX = ["js", "js", "js", "py", "py", "sql", "shell", "shell", "json", "css", "html"];

  function prose(words) {
    const out = [];
    for (let i = 0; i < words; i++) out.push(pick(WORDS));
    let s = out.join(" ");
    const paras = int(1, Math.max(1, Math.floor(words / 40)));
    for (let p = 0; p < paras; p++) {
      const at = int(0, s.length - 1);
      s = s.slice(0, at) + "\n\n" + s.slice(at);
    }
    return s;
  }

  /** A code clip in a single language, roughly `lines` long. */
  function codeBlob(lines) {
    const gens = LANGS[pick(LANG_MIX)];
    const parts = [];
    let count = 0;
    while (count < lines) {
      const snippet = pick(gens)("item_" + int(100, 999));
      parts.push(snippet);
      count += snippet.split("\n").length + 1;
    }
    return parts.join("\n\n");
  }

  /** Small synthetic screenshot-ish image as a data URL. */
  function makeImage(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const hue = int(0, 360);
    g.fillStyle = `hsl(${hue} 30% 16%)`;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < int(6, 22); i++) {
      g.fillStyle = `hsl(${(hue + int(0, 90)) % 360} ${int(35, 70)}% ${int(30, 62)}%)`;
      g.fillRect(int(0, w), int(0, h), int(8, w / 2), int(5, h / 3));
    }
    g.fillStyle = "rgba(255,255,255,.75)";
    for (let i = 0; i < int(3, 9); i++) g.fillRect(int(4, w / 2), int(4, h - 6), int(20, w / 2), 2);
    return c.toDataURL("image/jpeg", 0.6);
  }

  /**
   * @param {number} n    how many clips
   * @param {number} days spread over this many days back from now
   */
  function makeMockClips(n, days = 75) {
    seed = 1234567;
    const clips = [];
    const now = Date.now();

    for (let i = 0; i < n; i++) {
      const r = rnd();
      let type;
      let content;

      if (r < 0.10) {
        type = "image";
        content = makeImage(int(160, 460), int(120, 320));
      } else if (r < 0.36) {
        type = "code";
        content = codeBlob(rnd() < 0.05 ? int(300, 3000) : int(6, 60));
      } else if (r < 0.46) {
        type = "url";
        content = `https://${pick(["github.com", "developer.mozilla.org", "stackoverflow.com", "news.ycombinator.com"])}/` +
                  `${pick(WORDS)}/${pick(WORDS)}?ref=${int(1000, 9999)}`;
      } else {
        type = "text";
        content = prose(rnd() < 0.06 ? int(2000, 20000) : rnd() < 0.35 ? int(2, 10) : int(12, 400));
      }

      // Cluster into working sessions rather than spreading uniformly -- the
      // canvas looks, and is stressed, very differently when hours are lumpy.
      const dayBack = Math.floor(Math.pow(rnd(), 1.6) * days);
      const hour = pick([9, 10, 10, 11, 11, 14, 15, 15, 16, 20, 21, 22]);
      const d = new Date(now - dayBack * 86400000);
      d.setHours(hour, int(0, 59), int(0, 59), 0);

      clips.push({
        id: i + 1,
        type,
        content,
        title: null,
        source: "clipboard",
        tags: null,
        workspace_id: 1,
        board_id: null,
        is_starred: 0, is_archived: 0, is_pinned: 0,
        deleted_at: null,
        created_at: d.toISOString(),
        year: d.getFullYear(), month: d.getMonth() + 1,
        day: d.getDate(), hour: d.getHours(),
      });
    }
    return clips;
  }

  global.makeMockClips = makeMockClips;
})(typeof window !== "undefined" ? window : globalThis);
