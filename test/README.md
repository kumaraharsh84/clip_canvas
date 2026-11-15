# test/

The checks. Nothing here ships in the app.

```text
test/
  verify-*.js, capture-demo.js   the checks (below)
  seed-db.js                     builds the synthetic database verify-app.js can run on
```

## Checks

| Script | Runs on | What it checks |
| --- | --- | --- |
| `verify-classify.js` | Node | Clip classification — prose, terminal sessions, code by language — and that the type stored at capture time agrees with what the canvas shows |
| `verify-timecanvas-2d.js` | Node | Calendar and layout invariants on synthetic clips: every day in its weekday's column, wrapping is lossless, boxes never overlap, clips stay in copy order, every card's full text fits, and a new copy moves nothing outside its own day |
| `verify-clipwatch.js` | Node | The clipboard watcher against a fake clipboard: captures once, skips launch contents, repeated images, private copies and copy-back, stays quiet while paused, never lets two polls overlap, retries a failed read, reports capture broken and recovered, and refuses a clipboard API it does not know |
| `verify-hotkey.js` | Node | The global shortcut: its defaults, which combinations may be chosen, the canonical form it is saved in, and which one is used when others are taken |
| `verify-ipc.js` | Node | That the channels the main process answers, the preload's allow-list, and the events sent and listened for all agree |
| `verify-asset-protocol.js` | Node | The `clip-asset://` handler: serves stored images with the headers the canvas needs, and nothing outside the storage folder, however the path is spelled |
| `verify-db.js` | Electron | The migrations since schema v5, stored categories, the per-day queries the canvas loads through, storage figures, the duplicate check, search on a broad query, one file for identical pictures, and the query plans of everything that runs on every copy; `--live` also migrates a copy of your database |
| `verify-app.js` | Electron | The whole app — database, IPC, preload, renderer, canvas — against a **copy** of your database, or against synthetic clips when there is none (a fresh clone, CI, or `--synthetic`): opens on today, loads a year, a new copy moves nothing else, search reveals a clip, thumbnails and text render, the Settings window records, refuses and resets a shortcut, and the watcher can run on this Electron's clipboard |
| `capture-demo.js` | Electron | The README screenshots, taken from the demo page and its synthetic clips |

```bash
npm test                          # the six Node checks
npm run lint                      # ESLint
npm run test:db                   # the database check
npm run verify:app                # the end-to-end check
npm run screenshots               # rewrite docs/*.png
```

`verify-app.js --shots=DIR` photographs **your real clipboard history** unless
`--synthetic` is given. `out/` and `shots/` are git-ignored for that reason;
keep those images out of the repository.
