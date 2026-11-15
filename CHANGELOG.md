# Changelog

All notable changes to ClipCanvas. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A 512 px thumbnail is saved with every captured image and used by the
  zoomed-out canvas. Images captured earlier get theirs in the background.
- `npm run verify:app` runs on a fresh clone, against synthetic clips.

### Changed

- Electron 45. The clipboard watcher and *Copy back* use its asynchronous
  clipboard.
- Identical pictures are stored once, however often they are copied.
- A search that matches more than 1,000 clips is ranked among its newest
  1,000 matches.
- A new installation starts with a single workspace, Personal.
- The workspace and board selectors appear only when there is more than one
  to choose from.
- The corner readout shows the zoom level. Draw timings are shown in
  development runs only.

### Fixed

- Queries that slowed down as the history grew. Day counts, loading a day,
  the duplicate check, storage figures and broad searches take milliseconds
  at 30,000 clips.
- Stored images are read without blocking the main process.
- A copy is not read when the clipboard cannot say whether it is private.

### Removed

- IPC channels and database queries the app no longer used.

## [2.2.0] — 2026-09-26

### Added

- Settings window: shortcut, capture, Start with Windows, storage figures,
  the storage folder, the log and the version. Changes save as they are made.
- A recorder for choosing your own shortcut. Windows' basic shortcuts are
  refused, and ones that apps commonly use are allowed with a warning.
- Application logo and icons.

### Changed

- The default shortcut is Win+Alt+V, with Ctrl+Alt+V and Ctrl+Alt+Shift+V as
  fallbacks when another program owns it.
- The default menu bar is hidden.

### Fixed

- A shortcut that cannot be registered is logged and shown in Settings.

## [2.1.0] — 2026-09-26

### Added

- A fixed calendar: years side by side, months in a 4 × 3 grid, days in a
  week grid. A day's place depends only on its date.
- Map-style loading: zoomed out, each day is drawn from clip counts alone,
  and a day's clips load when its cell is large enough on screen.
- The window opens on today. The Today button or `T` flies back to it.
- Search as you type, with arrow keys and Enter.
- Capture status in the top bar, and pause or resume from it.
- Tray menu: Pause capture, Start with Windows, Open log file.
- Trash: restore a clip, or empty Trash after a confirmation.
- An error log at `%APPDATA%\clipcanvas\logs\clipcanvas.log`.

### Changed

- The clipboard is checked through Windows' change counter, so an idle check
  costs about a microsecond.
- Electron 43, electron-builder 26, better-sqlite3 13.
- The window runs in Electron's sandbox.
- Database schema 6: each clip's category is stored.

### Fixed

- Copies that password managers mark as private are never captured.
- A clipboard read that fails once is retried.
- `clip-asset://` serves files from the storage folder only.
- Resizing keeps the centre of the view.

### Removed

- The `electron-store` dependency.

## [2.0.0] — 2026-09-26

- Clipboard capture of text, links and images into SQLite, with additive
  migrations and full-text search.
- The Time Canvas: year → month → day → hour → clip, every card holding its
  complete text, four levels of detail, syntax colour by language.
- Classification of prose, terminal sessions and code by language.
- A demo page with synthetic clips, and a Windows installer.

[Unreleased]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/kumaraharsh84/clip_canvas/releases/tag/v2.0.0
