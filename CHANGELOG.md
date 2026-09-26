# Changelog

What changed in each version of ClipCanvas. Newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[2.1.0]: https://github.com/kumaraharsh84/clip_canvas/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/kumaraharsh84/clip_canvas/releases/tag/v2.0.0
