# ClipCanvas

**Your whole clipboard history, on one zoomable timeline.**

ClipCanvas keeps everything you copy on Windows — text, code, links and images —
and lays it out as one canvas. Years hold months, months hold days, days hold
hours, and each hour holds the clips you copied in it, in the order you copied
them. You don't open folders; you zoom in.

![Two and a half months of clips, coloured by kind](docs/overview.png)

- **In the order you copied.** An image copied between two text clips sits
  between them. Nothing is filed away by type.
- **The whole clip.** Every card holds its complete text, never a two-line
  preview. Long clips are small until you zoom in, and then every line is
  readable.
- **When, on every card.** Each clip shows the time you copied it.
- **Colour says what it is.** Prose, short snippets, links and images each have
  a colour, and so does code in each language: JavaScript, Python, SQL, HTML,
  CSS, JSON / config and shell.
- **Local.** One SQLite file and a folder of images on your own machine. Nothing
  is uploaded.

![One hour: every card is the complete clip, with the time it was copied](docs/hour.png)

| A day | One clip, up close |
| --- | --- |
| ![A day of clips, grouped by hour](docs/day.png) | ![A single HTML clip, syntax-coloured](docs/clip.png) |

<sub>Screenshots are from the demo page (`npm run demo`), which generates
synthetic clips.</sub>

## Quick start

```bash
npm install     # also rebuilds better-sqlite3 for Electron (postinstall)
npm start
```

ClipCanvas starts in the system tray. Press `Ctrl+Shift+V`, or click the tray
icon, to open or hide the window. Closing the window hides it; quit from the
tray menu.

To build the Windows installer:

```bash
npm run build   # dist/ClipCanvas Setup <version>.exe
```

## Using it

| | |
| --- | --- |
| scroll / pinch | zoom toward the cursor |
| drag | pan, with inertia |
| click | select a clip and open its details |
| double-click | fly into the box under the cursor |
| right-click / Backspace | fly back out one level |
| F / Home | fit everything |
| + / − · arrows | zoom · pan |
| / | search — Enter runs it, and clicking a result flies to that clip |
| Esc | close search or details, then hide the window |

- **Top bar** — choose the workspace and board, and show Active, Starred,
  Pinned, Archived, Trash or All clips. New clips are saved to the active
  workspace; Personal, Research and College are created on first run.
- **Details** — the full text or image, an editable title, and Copy back,
  Star, Pin, Archive and Delete. Delete moves a clip to Trash.
- **Timeline strip** — the days on screen are lit; click a day to fly to it.
- **Info panel** — where you are, what is under the cursor, and how many clips
  of each kind are in view.

## How it works

- **Capture.** The main process polls the clipboard every 700 ms. Images are
  checked first and saved as PNG under `storage/images/YYYY/MM/`; text is
  classified as a link, code or prose and stored in SQLite. Whatever is already
  on the clipboard when the app starts is not captured.
- **Storage.** [better-sqlite3](https://github.com/WiseLibs/better-sqlite3),
  with additive migrations and an FTS5 search index kept in step by triggers.
  Images reach the window through a `clip-asset://` protocol that resolves
  nothing outside the storage folder.
- **Canvas.** A canvas-2D engine in [`src/renderer/canvas`](src/renderer/canvas/README.md):
  an order-preserving strip treemap for the time boxes, per-card font fitting
  so that every card holds its whole text, and four levels of detail, from
  solid tiles to syntax-coloured glyphs. Laying out 20,000 clips takes about
  half a second.
- **Isolation.** The window runs with context isolation and a strict
  Content-Security-Policy. The preload script exposes an allow-list of IPC
  channels, never `ipcRenderer` itself.

The canvas's look is inspired by code-city visualisers that fly through a
source tree, where every file is a box and every box is readable up close.

## Scripts

| | |
| --- | --- |
| `npm start` | run the app |
| `npm run dev` | run it with DevTools, and show the window at launch |
| `npm run build` | build the Windows installer into `dist/` |
| `npm test` | classification and layout checks, on plain Node |
| `npm run verify:app` | check the real app end to end, against a copy of your database |
| `npm run bundle` | rebuild the canvas bundles after editing `src/renderer/canvas/` |
| `npm run demo` | serve the demo at <http://localhost:8790> |
| `npm run screenshots` | retake the screenshots in `docs/` from the demo |

The renderer runs under context isolation, so it loads one prebuilt bundle
instead of modules. GitHub Actions runs both checks on every push and fails if a
committed bundle does not match its sources.

## Project structure

```text
src/
  main/
    main.js            window, tray, hotkey, clipboard watcher, IPC
    db.js              SQLite data layer
    preload.js         allow-listed bridge to the renderer
    assetProtocol.js   clip-asset:// -- serves stored images
    classifyText.js    the type a captured clip is stored as
  renderer/
    index.html         UI shell
    style.css
    renderer.js        top bar, info panel, details, search
    canvas/            the Time Canvas engine -- see its README
    timecanvas.bundle.js   built from canvas/
  assets/              app and tray icon
demo/                  the canvas on its own, with synthetic clips
scratch/               checks, benchmarks and diagnostics -- see its README
planning/              product decisions, roadmap and audits
docs/                  screenshots
```

The Markdown files at the top level (`MILESTONES.md`, `PHASE-1A-*.md`, …) are
the planning record of v1.

## Data

Everything is stored in Electron's user-data folder:

```text
C:\Users\<you>\AppData\Roaming\clipcanvas\clipcanvas.db     the database
C:\Users\<you>\AppData\Roaming\clipcanvas\storage\images\   captured images
```

The tray menu's *Open storage folder* opens the second one.

- `created_at` is Unix **seconds**. Each clip also stores `year`, `month`,
  `day`, `weekday` and `hour`, which the time queries group by.
- Tables: `workspaces`, `boards`, `clips`, and `clips_fts`, an external-content
  FTS5 index maintained by triggers.
- Migrations are additive — `CREATE TABLE IF NOT EXISTS` and guarded
  `ALTER TABLE … ADD COLUMN` — so an existing install upgrades in place.

## Troubleshooting

### JavaScript error: `better_sqlite3.node` compiled against a different Node.js version

Run:

```bash
npx electron-builder install-app-deps
npm start
```

This rebuilds or downloads the Electron-compatible native binary.

### JavaScript error: `Cannot read properties of undefined (reading 'getPath')`

This usually means `ELECTRON_RUN_AS_NODE=1` is set in the shell environment.

Run:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

### `better-sqlite3` build error during install

First try:

```bash
npm install
npx electron-builder install-app-deps
```

If it still builds from source and fails, install Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK, then retry.

### Build fails: `Cannot create symbolic link ... libcrypto.dylib`

`npm run build` downloads electron-builder's `winCodeSign` bundle and extracts
it with 7-Zip. That archive contains **macOS** symlinks, and creating a symlink
on Windows needs either administrator rights or Developer Mode — so extraction
fails, and the build dies during `packaging`, before NSIS ever runs:

```text
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : ...\winCodeSign\<id>\darwin.12\lib\libcrypto.dylib
```

Nothing in a Windows build needs those `darwin/` files. The fix is to extract
the archive yourself without them, into the exact directory electron-builder
looks for — `winCodeSign-2.6.0`, **not** `winCodeSign`. It will then skip the
download entirely:

```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
./node_modules/7zip-bin/win/x64/7za.exe x -y "$CACHE"/*.7z   -o"$CACHE/winCodeSign-2.6.0" '-xr!darwin'
rm -rf "$CACHE"/[0-9]*          # failed attempts leave numbered temp dirs
```

The permanent alternative is to turn on **Settings → System → For developers →
Developer Mode**, which grants symlink privilege to non-admin users; then the
normal download path works.

### Panel does not appear

The app starts as a tray utility. Press `Ctrl+Shift+V`, or open it from the ClipCanvas icon in the Windows system tray.

### Hotkey conflict

Edit the hotkey registration in `src/main/main.js`.

## What's Coming In v3

- AI auto-grouping with local embeddings
- Semantic search, such as "that code from yesterday"
- Source tracking for copied content
- Drag-and-drop reordering on the canvas
- File clip support
- Optional cloud sync
