# Time Canvas (canvas-2D)

Everything you have copied, on one zoomable calendar:
**Year → Month → Day → Hour → Clip**, nested as boxes inside boxes. You don't
navigate into a level, you fly into it.

- Years, months and days are a **fixed calendar**: a day's place comes from its
  date alone, so nothing ever moves when you copy something new.

- Clips appear **in the order you copied them** — a screenshot taken between two
  text clips sits between them, not filed away with the other images.
- Every card shows **when** it was copied, and its **complete** text — nothing is
  truncated. Long clips are small until you zoom in, then fully readable.
- Colour is **what kind of clip** it is: prose, short snippet, link, image, and
  per language for code (JavaScript, Python, SQL, HTML, CSS, JSON, shell).

## Files

| File | Role |
| --- | --- |
| `calendar.js` | Where every year, month and day sits; per-day counts and heat colours |
| `layout.js` | One day's hours and cards: card sizing, order-preserving strip layout |
| `textlayout.js` | Wrapping, line counting, column flow, per-card font fitting |
| `classify.js` | Category detection (incl. code language) and palettes |
| `tokens.js` | Splits lines into coloured runs — the line texture |
| `renderer2d.js` | The painter: four detail levels, culling, labels, thumbnails |
| `texturecache.js` | Pre-painted card textures for the zoomed-out mosaic |
| `imagecache.js` | Off-thread thumbnail decode, byte-budgeted LRU |
| `controls.js` | Smooth zoom, drag inertia, fly in/out, hover, keys |
| `timelinestrip.js` | The day-by-day strip under the canvas |
| `describe.js` | Plain-data description of a node for the info panel |
| `viewport.js` · `lod.js` · `lru.js` | Transform, level names, caches |
| `index.js` | `mountTimeCanvas()`, the dirty-driven frame loop, loading days as they come into view |
| `build.js` | Bundles all of it into one browser-loadable file |

## A calendar that never moves

Laying the whole history out as one treemap would make every copy move
every card. Instead:

- **Years** sit side by side, anchored at `(year − 2000)`, so a year's position
  does not depend on which other years exist.
- **Months** are a 4 × 3 grid inside their year; **days** a 7-column, 6-row
  week grid inside their month (Sunday first).
- **Inside a day**, and only there, the layout depends on the clips: hours,
  then cards, in copy order (`layout.fillDay`).

Because every day's place is known without its clips, the canvas loads like a
map. `source.dayCounts()` — clips per day per category, for all of history —
draws every day as a heat cell. When a cell is at least 26 px wide on screen,
`source.forDays()` fetches its clips, nearest the centre first, one request at
a time; past 40,000 loaded clips, days off screen are dropped. A day's `sig`
(count, last copy, last edit or delete) tells the canvas which loaded days
went stale after `refresh()` — in practice, only today.

```js
const tc = mountTimeCanvas(host, { onSelect, onHover, onFrame, resolveImage });
await tc.setSource({ dayCounts: () => …, forDays: (days) => … }, { view: "today" });
tc.refresh();          // after a capture or an edit
await tc.reveal(clip); // load its day, fly to it, select it
tc.setClips(rows);     // or an in-memory array (the demo)
```

## How it gets the look

**Box size is decoupled from text size.** A card's area grows with the square
root of its length, clamped to 0.35–8× a typical card, and each card then picks
its own font scale so its whole text fits (`fitCard`). If area equalled text
area, one 38,000-character paste would take 8% of the canvas; this way the
largest card is well under 1%.

**Four detail levels per card.** A few pixels: a solid tile in the category
colour. Tens of pixels: a cached texture of coloured dashes. Lines ≥ 2.4 px:
dashes drawn live. Font ≥ 6.5 px: real syntax-coloured glyphs. Dashes are
snapped to whole pixels so they stay crisp.

**Order-preserving layout without slivers.** A strip treemap keeps time order.
Three rules keep its boxes a readable shape:

- strips grow by the *worst* box aspect, not the mean (the mean let 1-unit-wide
  slivers through);
- each box is floored at 1/12 of its largest sibling, so a quiet hour next to a
  busy one is not a sliver;
- a floored box lays its children out at natural size, anchored top-left, rather
  than stretching one lone clip into a giant card — a quiet hour *looks* quiet.

**Columns stay readable.** Text flows into columns at least 12 lines tall and
20–120 characters wide; the font shrinks rather than break those limits.

**Every clip is readable, not just present.** The viewport's maximum zoom is
raised to fit the smallest text of any loaded day, so any clip can be zoomed to
≥ 7 px.

## What kind of clip it is

A copied chat message, prompt or report can look like code, and a terminal
session can look like JSON or SQL. `classify.js` decides in this order:

1. **Terminal session → Shell** if it *starts* at a prompt or command, is
   command output shaped like a table, or ≥30% of its lines are prompts,
   commands or command output. Per line, never "anywhere": a chat that quotes
   one command is still a chat.
2. **JSON / key-value config** — recognised by structure, so certain.
3. **Prose → Text**, judged by shape, not vocabulary, so Hinglish counts
   (few code symbols, mostly plain words, sentence-length lines). Markdown
   tables and `=====` dividers are layout, not symbols. Never applied to a clip
   that starts like a source file (`import`, `def`, `const`…) or is shaped like
   SQL — SQL is English words with few symbols.
4. **Otherwise, the language** (JavaScript, Python, SQL, HTML, CSS, …).

The capture side (`src/main/classifyText.js`) uses the same detectors, so what
is stored and what is shown agree. `node test/verify-classify.js` checks both
against synthetic examples of every case above.

Known gap: nested YAML (`services:` → `web:` → `image: nginx`) is not recognised
as config; it shows as Other code.

## Controls

| | |
| --- | --- |
| scroll / pinch | smooth zoom toward the cursor |
| drag | pan, with inertia |
| click | select a clip |
| double-click | fly into the box under the cursor |
| right-click / Backspace | fly back out one level |
| F / Home | fit everything |
| T | today |
| + / − · arrows | zoom · pan |

The timeline strip lights the days currently on screen; click a day to fly to it.

## Verify

```bash
node test/verify-timecanvas-2d.js --clips=20000
npx electron test/verify-app.js --perf --shots=out
```

The first runs on plain Node: wrapping is exact and lossless; the calendar has
every day in its weekday's column with nothing overlapping, and a day's place
does not depend on which years are shown; inside every day no boxes overlap,
clips are in copy order, and — for every card — the full text fits at its own
font scale, columns have a readable shape, no card is a sliver or swallows its
day, and the smallest text is reachable at max zoom. Then it adds a clip to the
busiest day, lays out every day again, and checks that no card in any other day
moved. Measured at 20,000 clips over 88 days: 669 ms to lay out every day,
0 of 18,680 cards moved.

The second drives the real app against a **copy** of your database (or, with
`--synthetic` or when there is none, against synthetic clips): it opens
on today, loads a year, adds a clip and checks nothing outside today moved,
reveals a clip through search, and writes screenshots. It renders offscreen, because a hidden
window stops producing frames and `capturePage` returns a stale one.

## Demo

```bash
node demo/serve.js
```

Open <http://localhost:8790> and pick up to 40,000 synthetic clips.

## Rebuild the bundle after editing any module

The renderer runs under `contextIsolation`, so it loads a bundle, not modules.
The demo page loads the same file:

```bash
npm run bundle          # writes src/renderer/timecanvas.bundle.js
npm run bundle:check    # what CI runs: rebuild, then fail on any difference
```

## Notes

- `created_at` is INTEGER Unix **seconds**; `layout.toDate` handles that.
- Container keys are full paths (`root/y2026/m9/d5/h12`) so the current-hour
  marker lights exactly one hour, not the same hour on every day.
- Card textures are keyed by `texKey`, which changes each time the card's day
  is laid out again — a texture painted for a card's old shape is never reused.
- The page CSP is `style-src 'self'`: set colours through `element.style`, never
  as `style="…"` in HTML strings, or they are silently dropped.
