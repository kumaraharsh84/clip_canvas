# scratch/

Checks, benchmarks and diagnostics. Nothing here ships in the app.

## Current checks

These run against the code in `src/` as it is now.

| Script | Runs on | What it checks |
| --- | --- | --- |
| `verify-classify.js` | Node | Clip classification — prose, terminal sessions, code by language — and that the type stored at capture time agrees with what the canvas shows |
| `verify-timecanvas-2d.js` | Node | Calendar and layout invariants on synthetic clips: every day in its weekday's column, wrapping is lossless, boxes never overlap, clips stay in copy order, every card's full text fits, and a new copy moves nothing outside its own day |
| `verify-db.js` | Electron | The schema v6 migration, stored categories, and the per-day queries the canvas loads through; `--live` also migrates a copy of your database |
| `verify-app.js` | Electron | The whole app — database, IPC, preload, renderer, canvas — against a **copy** of your database: opens on today, loads a year, a new copy moves nothing else, search reveals a clip |
| `capture-demo.js` | Electron | The README screenshots, taken from the demo page and its synthetic clips |

```bash
npm test                          # both Node checks
npm run test:db                   # the database check
npm run verify:app                # the end-to-end check
npm run screenshots               # rewrite docs/*.png
```

`verify-app.js --shots=DIR` photographs **your real clipboard history**. `out/`
and `shots/` are git-ignored for that reason; keep those images out of the
repository.

## Diagnostics

Standalone: they do not load anything from `src/`.

| Script | What it does |
| --- | --- |
| `check_clipboard.js`, `read_clipboard_formats.js` | Print the formats currently on the clipboard |
| `test_clipboard_files.js` | Experiments in reading the paths of files copied in Explorer |
| `benchmark-search.js` | Times `LIKE` against FTS5 search on a throwaway database |

`better-sqlite3` is built for Electron's Node, so run the benchmark under
Electron rather than plain Node:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scratch/benchmark-search.js
```

## From v1

The v1 source was lost, and `src/` is a rewrite. These scripts were written
against v1: they call its module API (`insertClip`, `trashClip`,
`getDefaultWorkspaceId`, and `src/main/clipboard.js`, `settings.js` and
`storage/storageService.js`, which no longer exist), and the renderer
harnesses probe the DOM of the old renderer. They do not run against the
current code without updating; they are kept for the record.

| Script | What it did |
| --- | --- |
| `benchmark-renderer.js` | Load, render, scroll and search timings for the renderer; wrote the result files below |
| `verify-time-canvas.js`, `verify-time-zoom.js` | Walked the DOM Time Canvas level by level, and its zoom ladder |
| `verify_storage_v2.js`, `verify_file_support.js`, `verify_stability.js`, `verify_content_projection.js` | Storage v2, file capture, stability and content projection |
| `v1_audit.js` | End-to-end audit of the V1 feature list |

### Benchmark results

| File | Run |
| --- | --- |
| `../benchmark_results.june-baseline.json` | The June baseline, before FTS5 search and the 200-result cap |
| `../benchmark_results.json` | A 30 August run — the script's default output file |
| `bench-smoketest.json`, `sweep-*.json` | 30 August: a smoke test, then a sweep from 250 to 2,000 clips |
| `fixed-*.json`, `fixed2-*.json` | Later runs at the same sizes, as renderer fixes landed |
| `ops-*.json`, `profile-1000.json`, `real-2000.json` | DOM operation counts and a per-function profile |
| `post-timecanvas.json` | After the DOM Time Canvas landed |

Each file's `_meta.comparability` says which numbers can be compared with the
June baseline — search, for one, changed underneath it.
