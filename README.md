<p align="center">
  <img src="src/assets/logo.svg" width="112" alt="ClipCanvas logo: a clipboard holding a mosaic of coloured clips">
</p>

<h1 align="center">ClipCanvas</h1>

<p align="center"><b>Your whole clipboard history, on one zoomable calendar.</b></p>

ClipCanvas keeps everything you copy on Windows — text, code, links and images —
and lays it out on one canvas shaped like a wall calendar. Every day has its own
cell, and it never moves: zoom into a day and it holds its hours, and each hour
holds the clips you copied in it, in the order you copied them. You don't open
folders; you zoom in.

<p align="center">
  <img src="docs/zoom.gif" width="640" alt="Flying from a whole year of clips, through a month, a day and an hour, down to one clip whose every line is readable, and back out">
</p>

- **Everything stays where it is.** A day's place comes from its date alone,
  like a drawing in AutoCAD. Copying something new changes today and nothing
  else; June is always where June was.
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

![A year of clips: every day is a cell, filled with what was copied that day](docs/overview.png)

![One hour: every card is the complete clip, with the time it was copied](docs/hour.png)

| A month | A day |
| --- | --- |
| ![A month, as a wall calendar](docs/month.png) | ![A day of clips, grouped by hour](docs/day.png) |

![One clip, up close: syntax-coloured, complete](docs/clip.png)

<sub>The animation and screenshots are from the demo page (`npm run demo`), which generates
synthetic clips.</sub>

## Quick start

```bash
npm install     # also rebuilds better-sqlite3 for Electron (postinstall)
npm start       # the first run downloads Electron itself, about 130 MB
```

Or install it like any Windows app: `npm run build` writes
`dist/ClipCanvas Setup <version>.exe`. The installer is not code-signed, so
Windows SmartScreen warns the first time it runs: choose *More info*, then
*Run anyway*. What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

ClipCanvas starts in the system tray. Press `Win+Alt+V`, or click the tray
icon, to open or hide the window. Closing the window hides it; quit from the
tray menu. It starts with Windows from then on. The shortcut, capture and
start-up are all in **Settings** (the top bar, `Ctrl+,`, or the tray menu).

If another program already owns `Win+Alt+V`, ClipCanvas falls back to
`Ctrl+Alt+V`, then `Ctrl+Alt+Shift+V`, and Settings says which one it is using.

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
| T | today |
| + / − · arrows | zoom · pan |
| / | search — results appear as you type; ↑ ↓ and Enter, or click, fly to a clip |
| Ctrl+, | Settings |
| Esc | close search or details, then hide the window |

- **Opens on today.** The current day is outlined in green. Scroll out for the
  month, the year, and every year you have.
- **Top bar** — show Active, Starred, Pinned, Archived, Trash or All clips,
  and choose the workspace and board once there is more than one. *Capturing* shows whether copies are
  being saved; click it to pause. *Today* and *Fit* move the camera. New clips
  are saved to the active workspace; one named Personal is created on first
  run.
- **Details** — the full text or image, an editable title, and Copy back,
  Star, Pin, Archive and Delete. Delete moves a clip to Trash; in Trash,
  Restore brings it back and *Empty trash* deletes everything there for good,
  after telling you how many clips and how much space.
- **Settings** — change the shortcut (click the keys, press a new
  combination), pause capture, Start with Windows, see how much is stored,
  and open the storage folder or the log. Changes save as you make them.
- **Timeline strip** — the days on screen are lit; click a day to fly to it.
- **Info panel** — where you are, what is under the cursor, and how many clips
  of each kind are in view.

## How it works

- **Capture.** The main process asks Windows every 700 ms whether the
  clipboard has changed (`GetClipboardSequenceNumber`, through
  [koffi](https://koffi.dev)) — about a microsecond — and reads the clipboard
  only when it has. Reads are asynchronous (Electron 45), and run strictly
  one after another, so a copy is never captured twice. Images are checked first and saved as PNG under
  `storage/images/YYYY/MM/`, with a 512 px thumbnail beside them for the
  zoomed-out canvas; the same picture copied twice is two clips and one
  file. Text is classified as a link, code or prose and stored in SQLite. Whatever is already on the clipboard when the app starts is
  not captured, and neither is anything a password manager marks as private.
  Capture can be paused from the tray or the top bar.
- **Storage.** [better-sqlite3](https://github.com/WiseLibs/better-sqlite3),
  with additive migrations and an FTS5 search index kept in step by triggers.
  Everything that runs on every copy or every keystroke is answered from an
  index or from a bounded number of rows, so it does not slow down as the
  history grows.
  Images reach the window through a `clip-asset://` protocol that resolves
  nothing outside the storage folder.
- **Canvas.** A canvas-2D engine in [`src/renderer/canvas`](src/renderer/canvas/README.md):
  a fixed calendar for years, months and days; inside each day an
  order-preserving strip treemap of hours and clips, with per-card font fitting
  so that every card holds its whole text; and four levels of detail, from
  solid tiles to syntax-coloured glyphs.
- **Loading like a map.** Zoomed out, the canvas needs only how many clips of
  each kind every day has — one small query. A day's clips are fetched when its
  cell is big enough on screen to show them, and dropped again when it is far
  away, so the history can grow without the window slowing down. A new copy
  re-reads the counts and reloads today only.
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
| `npm test` | classification, calendar, layout, clipboard watcher, image-protocol, shortcut and IPC checks, on plain Node |
| `npm run lint` | ESLint (correctness rules only) |
| `npm run test:db` | database migration and per-day queries (under Electron) |
| `npm run verify:app` | check the real app end to end, against a copy of your database, or synthetic clips when there is none |
| `npm run bundle` | rebuild the canvas bundle after editing `src/renderer/canvas/` |
| `npm run demo` | serve the demo at <http://localhost:8790> |
| `npm run screenshots` | retake the screenshots in `docs/` from the demo |
| `npm run icons` | rebuild `src/assets/icon.ico` and `icon.png` from `logo.svg` |
| `npm run gif` | re-record `docs/zoom.gif` from the demo |

The renderer runs under context isolation, so it loads one prebuilt bundle
instead of modules; the demo page loads the same file. GitHub Actions runs the
lint and the plain-Node checks on every push to `main` and every pull request,
fails if the committed bundle does not match its sources, and on Windows runs
the database and end-to-end checks under Electron.

## Project structure

```text
src/
  main/
    main.js            windows, tray, global shortcut, start with Windows
    ipc.js             every channel the windows may call, and what answers it
    hotkey.js          the shortcut's defaults and rules
    clipwatch.js       clipboard watcher: change detection, private copies skipped
    images.js          how an image is stored: picture, thumbnail, one file per picture
    log.js             the log file
    settings.js        small settings file (shortcut, pause, start with Windows)
    db.js              SQLite data layer
    preload.js         allow-listed bridge to the renderer
    assetProtocol.js   clip-asset:// -- serves stored images
    classifyText.js    the type a captured clip is stored as
  renderer/
    index.html         UI shell
    theme.css          colours and controls shared by both windows
    style.css
    renderer.js        top bar, info panel, details, search
    settings.html      the Settings window (+ settings.css, settings.js)
    canvas/            the Time Canvas engine -- see its README
    timecanvas.bundle.js   built from canvas/
  assets/              logo.svg (+ logo-small.svg for 16-32 px) and the icons built from them
demo/                  the canvas on its own, with synthetic clips (loads the app's bundle)
tools/                 build-icons.js (`npm run icons`), record-gif.js (`npm run gif`)
test/                  checks and diagnostics -- see its README
planning/              product decisions, roadmap and feature status
docs/                  screenshots
```

## Data

Everything is stored in Electron's user-data folder:

```text
C:\Users\<you>\AppData\Roaming\clipcanvas\clipcanvas.db     the database
C:\Users\<you>\AppData\Roaming\clipcanvas\storage\images\   captured images
C:\Users\<you>\AppData\Roaming\clipcanvas\storage\thumbs\   their thumbnails
C:\Users\<you>\AppData\Roaming\clipcanvas\logs\              clipcanvas.log: errors and events
```

The tray menu opens the storage folder and the log.

- `created_at` is Unix **seconds**. Each clip also stores `year`, `month`,
  `day`, `weekday` and `hour`, which the time queries group by.
- Tables: `workspaces`, `boards`, `clips`, and `clips_fts`, an external-content
  FTS5 index maintained by triggers.
- Migrations are additive — `CREATE TABLE IF NOT EXISTS` and guarded
  `ALTER TABLE … ADD COLUMN` — so an existing install upgrades in place.

## Privacy

- **Nothing leaves this computer.** The history is the database and the image
  folders listed above. ClipCanvas has no account, no sync, no telemetry and
  no update check, and its windows are not allowed to load anything from the
  network.
- **Everything you copy is kept until you delete it**: text, links and images.
  Delete moves a clip to Trash, and *Empty trash* removes it and its files for
  good.
- **Nothing is encrypted.** Whoever can read your Windows user folder can read
  your history.
- **Never captured:** a copy that an app marks as private, which is what
  password managers do; whatever was on the clipboard when ClipCanvas started;
  anything copied while capture is paused; files copied in Explorer.
- **A password copied from an app that does not mark it** is stored like any
  other text. Pause capture first, from the tray or the pill in the top bar,
  or delete the clip afterwards and empty Trash.

## Troubleshooting

### `better_sqlite3.node` was compiled against a different Node.js version

`better-sqlite3` is a native module, and it must match Electron's Node ABI, not
your system Node's:

```text
The module better_sqlite3.node was compiled against a different Node.js version.
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 121.
```

Rebuild it for Electron:

```bash
npx electron-builder install-app-deps
npm start
```

### `Cannot read properties of undefined (reading 'getPath')`

Electron is running as plain Node because `ELECTRON_RUN_AS_NODE=1` is set in
the shell. Clear it and start again:

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

If it still builds from source and fails, install Visual Studio Build Tools with
the Desktop development with C++ workload and a Windows SDK, then retry.

### Build fails: `Cannot create symbolic link ... libcrypto.dylib`

`npm run build` downloads electron-builder's `winCodeSign` bundle and extracts
it with 7-Zip. That archive contains **macOS** symlinks, and creating a symlink
on Windows needs either administrator rights or Developer Mode — so extraction
fails, and the build dies during `packaging`, before NSIS ever runs:

```text
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : ...\winCodeSign\<id>\darwin.12\lib\libcrypto.dylib
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

### Nothing new is being captured

Check the pill in the top bar. *Capture paused*: click it to resume. *Capture
error*: the clipboard cannot be read — tray menu → *Open log file* says why. If ClipCanvas was not running at all, it may not be
registered to start with Windows: open it once with `npm start` and make sure
*Start with Windows* is ticked in the tray menu.

### The window does not appear

ClipCanvas starts as a tray utility. Press `Win+Alt+V` (or the shortcut shown
in Settings), or open it from the ClipCanvas icon in the Windows system tray.

### The shortcut does nothing, or another app stopped reacting to it

Another program may own the same shortcut. Open Settings (tray menu →
*Settings…*): it shows the shortcut ClipCanvas is actually using and why. Click
the keys and press a different combination; ClipCanvas refuses Windows' basic
shortcuts and warns about ones apps commonly use.

## Roadmap

From [`planning/`](planning/):

- Grouped view for busy hours: folders by kind inside an hour
- Cleanup by hour, day, month and year, with starred and pinned clips protected
- A small always-available capsule near the taskbar, with copy feedback
- Search by date and kind: `today`, `last week`, `images june 2026`
- File and PDF clips
