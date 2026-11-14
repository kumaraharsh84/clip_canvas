# test/

Checks and diagnostics. Nothing here ships in the app.

```text
test/
  verify-*.js, capture-demo.js   the current checks (below)
  diagnostics/                   standalone clipboard and search experiments
```

## Current checks

These run against the code in `src/` as it is now.

| Script | Runs on | What it checks |
| --- | --- | --- |
| `verify-classify.js` | Node | Clip classification — prose, terminal sessions, code by language — and that the type stored at capture time agrees with what the canvas shows |
| `verify-timecanvas-2d.js` | Node | Calendar and layout invariants on synthetic clips: every day in its weekday's column, wrapping is lossless, boxes never overlap, clips stay in copy order, every card's full text fits, and a new copy moves nothing outside its own day |
| `verify-clipwatch.js` | Node | The clipboard watcher against a fake clipboard: captures once, skips launch contents, repeated images, private copies and copy-back, stays quiet while paused, retries a failed read, reports capture broken and recovered, and refuses a clipboard API it does not know |
| `verify-hotkey.js` | Node | The global shortcut: its defaults, which combinations may be chosen, the canonical form it is saved in, and which one is used when others are taken |
| `verify-asset-protocol.js` | Node | The `clip-asset://` handler: serves stored images with the headers the canvas needs, and nothing outside the storage folder, however the path is spelled |
| `verify-db.js` | Electron | The schema v6 migration, stored categories, and the per-day queries the canvas loads through; `--live` also migrates a copy of your database |
| `verify-app.js` | Electron | The whole app — database, IPC, preload, renderer, canvas — against a **copy** of your database: opens on today, loads a year, a new copy moves nothing else, search reveals a clip, thumbnails and text render, the Settings window records, refuses and resets a shortcut, and the watcher can run on this Electron's clipboard |
| `capture-demo.js` | Electron | The README screenshots, taken from the demo page and its synthetic clips |

```bash
npm test                          # the five Node checks
npm run lint                      # ESLint
npm run test:db                   # the database check
npm run verify:app                # the end-to-end check
npm run screenshots               # rewrite docs/*.png
```

`verify-app.js --shots=DIR` photographs **your real clipboard history**. `out/`
and `shots/` are git-ignored for that reason; keep those images out of the
repository.

## diagnostics/

Standalone: they do not load anything from `src/`.

| Script | What it does |
| --- | --- |
| `check_clipboard.js`, `read_clipboard_formats.js` | Print the formats currently on the clipboard |
| `test_clipboard_files.js` | Experiments in reading the paths of files copied in Explorer — the starting point for capturing copied files |
| `benchmark-search.js` | Times `LIKE` against FTS5 search on a throwaway database |

```bash
npx electron test/diagnostics/read_clipboard_formats.js
```

`better-sqlite3` is built for Electron's Node, so run the benchmark under
Electron rather than plain Node:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/diagnostics/benchmark-search.js
```
