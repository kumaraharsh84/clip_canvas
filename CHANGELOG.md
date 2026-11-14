# Changelog

What changed in each version of ClipCanvas. Newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Housekeeping before the repository goes public. Nothing new in the app.

### Fixed

- **Four queries slowed down as the history grew**, each on the process that
  also watches the clipboard. Measured on 30,000 clips (136 MB):

  | Query | Runs | Before | After |
  | --- | --- | --- | --- |
  | Storage figures | Settings opens or changes | 1,700 ms | 5 ms |
  | Day counts | every copy | 375 ms | 14 ms |
  | One day's clips | each day that scrolls into view | 345 ms | 2 ms |
  | Duplicate check | every text copy | 300 ms | 3 ms |

  They read columns stored after a clip's text, so SQLite walked every
  large clip. Now the counts and the storage figures are answered from an
  index alone, a day's clips are found by their day, and the duplicate
  check looks at the newest rows only. Database schema 7: one index
  replaces another, on first launch.
- **Search on a broad query** ("t", "the") scored every match: 0.3 to 1
  second per keystroke at 30,000 clips, now 30 to 70 ms. A query matching
  more than 1,000 clips is ranked among its newest 1,000; one matching
  fewer is ranked in full, as before.
- **Images were decoded at full size for the zoomed-out canvas**, and read
  in a way that blocked the main process. A 512 px thumbnail is now saved
  with each captured image and used up to that width; images stored
  earlier get theirs in the background after launch. Reads no longer
  block.
- **The same picture copied twice was stored twice.** It is now two clips
  and one file, and *Empty trash* removes a file only with the last clip
  that used it. Database schema 8.
- Day counts under the Starred and Pinned filters, and classifying a copied
  text twice.

### Changed

- **Electron 43 → 45**, with the clipboard watcher and *Copy back* moved to
  Electron's new asynchronous clipboard (43 leaves support in December).
  Polls never overlap, a copy-back is still never captured, and private
  copies are still skipped; if the clipboard cannot say whether a copy is
  private, it is not read. A captured picture is stored as the PNG the
  clipboard gives, without being encoded again. better-sqlite3 13.1,
  koffi 3.3.8, electron-builder 26.18.
- A new installation starts with one workspace, Personal. The Research and
  College workspaces and their boards were the author's own; existing
  databases keep theirs.
- The demo page loads the app's canvas bundle instead of a second committed
  copy. `npm run bundle` writes one file, and `npm run bundle:check` is what
  CI runs.
- CI: checks run once per pull request instead of twice, with a read-only
  token, a cached npm download, and superseded runs cancelled.
- The workspace settings no longer format on save: the code is laid out by
  hand (see `eslint.config.js`).
- The workspace and board dropdowns appear only when there is something to
  choose, and the corner readout shows where the zoom is (`months · 400%`)
  instead of draw timings, which are kept for `npm run dev`.
- One table of IPC channels (`src/main/ipc.js`), registered by the app and
  by its end-to-end check; `test/verify-ipc.js` holds the preload's
  allow-list to it.
- `npm run verify:app` runs on a fresh clone: without a database to copy
  it builds one from synthetic clips. CI runs it, and the database check,
  under Electron on Windows.
- The README says what is stored, what is not, and who can read it.

### Removed

- IPC channels and database methods that nothing in the app called: the
  year / month / day / hour queries and page loaders of the first canvas,
  sessions, bulk archive, single-clip reads, `storage:getStats`, two stubs,
  and the `window.clipcanvas` alias of `window.api`.
- Unused helpers in the canvas modules.
- The v1 planning notes and v1 test harnesses, which described code that no
  longer exists.

## [2.2.0] — 2026-09-26

### Added

- **A logo**: a clipboard holding the time mosaic, in the canvas's own colours
  -- on the windows, the taskbar, the tray, the installer, the top bar and the
  README. A simplified version keeps it clear at 16-32 px. `npm run icons`
  rebuilds every size from the SVG.
- **An animation at the top of the README**: a year of (synthetic) clips flown
  through down to one readable clip. `npm run gif` records it from the demo.
- **Settings window** — tray menu, the top bar or `Ctrl+,`: the shortcut,
  capture, Start with Windows, how much is stored, the storage folder and log,
  and the version. Changes save as you make them.
- **Choose your own shortcut**: click the keys and press a combination. Windows'
  basic shortcuts are refused; ones that apps commonly use are allowed with a
  warning; one another program already owns keeps the old shortcut working.

### Changed

- **The default shortcut is now Win+Alt+V** instead of Ctrl+Shift+V, which took
  "paste as plain text" away from Chrome, Edge and Word, "paste" from Windows
  Terminal and Markdown preview from VS Code. If another program owns Win+Alt+V,
  ClipCanvas uses Ctrl+Alt+V, then Ctrl+Alt+Shift+V, and Settings says so.
- The window no longer shows Electron's default File / Edit / View menu bar.

### Fixed

- A shortcut that could not be registered failed silently; it is now logged and
  shown in Settings.

## [2.1.0] — 2026-09-26

### Added

- **A calendar that never moves.** Years sit side by side, months in a 4 × 3
  grid, days in a week grid. A day's place depends only on its date, so a new
  copy changes today and nothing else — before, every copy moved every clip.
- **Loading like a map.** Zoomed out, each day is a coloured cell drawn from
  clip counts alone; a day's clips load when it is big enough on screen, and
  far-away days are let go again.
- **Opens on today.** The Today button or `T` flies back from anywhere; empty
  days say *Nothing copied*.
- **Search as you type**, with ↑ ↓ and Enter. Opening a result loads its day and
  flies to the clip, even when that day was not loaded.
- **Capture status in the top bar**: *Capturing*, *Capture paused* or *Capture
  error*. Click it to pause or resume.
- **Tray menu**: Pause capture, Start with Windows (on by default), Open log
  file.
- **Trash**: Restore a clip; *Empty trash* after a confirmation that shows the
  count and size.
- **Error log** at `%APPDATA%\clipcanvas\logs\clipcanvas.log`: startup,
  crashes, clipboard failures, failed requests.

### Changed

- The clipboard is checked through Windows' change counter: an idle check costs
  about a microsecond, where it used to take ~440 ms every 0.7 s whenever a
  screenshot was on the clipboard.
- Electron 29 → 43, electron-builder 24 → 26, better-sqlite3 12 → 13. No known
  vulnerabilities in the dependencies.
- The window runs in Electron's sandbox.
- The installer contains only the app — no tests, demo or screenshots.
- Database schema 6: each clip's category is stored, and days can be counted
  and loaded whole.

### Fixed

- Copies that password managers mark as private are never captured.
- A clipboard read that fails once (another app holding the clipboard) is
  retried instead of losing that copy.
- Past 20,000 clips, the newest are kept rather than the oldest.
- Thumbnails load under newer Chromium, which blocked the image requests.
- `clip-asset://` could serve a file from a folder next to the storage folder
  whose name started the same way.
- At midnight, the new today no longer looks like a future day.
- Resizing keeps the centre of the view; today stays in view on launch.
- Only one workspace is the default (College could become the capture target).
- Starring, pinning or archiving no longer rebuilds the search index.

### Removed

- The unused `electron-store` dependency.
- `Start_ClipCanvas_Hidden.vbs`: the app registers itself to start with Windows.

## [2.0.0] — 2026-09-26

A rewrite, after the v1 source was lost; the first version pushed to GitHub.

- Main process and database layer rebuilt against the live database, with
  additive migrations and full-text search.
- A canvas-2D Time Canvas: year → month → day → hour → clip, every card holding
  its complete text, four levels of detail, syntax colour by language.
- Classification of prose, terminal sessions and code by language.
- A demo page with synthetic clips, and a Windows installer.

[Unreleased]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/kumaraharsh84/clip_canvas/releases/tag/v2.0.0
