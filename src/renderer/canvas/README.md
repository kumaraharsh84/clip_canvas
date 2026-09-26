# Time Canvas (canvas-2D)

Everything you have copied, as one continuous zoomable timeline:
**Year → Month → Day → Hour → Clip**, nested as boxes inside boxes the way a
code-city visualiser nests directories and files. You don't navigate into a
level, you fly into it.

- Clips appear **in the order you copied them** — a screenshot taken between two
  text clips sits between them, not filed away with the other images.
- Every card shows **when** it was copied, and its **complete** text — nothing is
  truncated. Long clips are small until you zoom in, then fully readable.
- Colour is **what kind of clip** it is: prose, short snippet, link, image, and
  per language for code (JavaScript, Python, SQL, HTML, CSS, JSON, shell).

## Files

| File | Role |
| --- | --- |
| `layout.js` | Tree building, card sizing, order-preserving strip layout |
| `textlayout.js` | Wrapping, line counting, column flow, per-card font fitting |
| `classify.js` | Category detection (incl. code language) and palettes |
| `tokens.js` | Splits lines into coloured runs — the line texture |
| `renderer2d.js` | The painter: four detail levels, culling, labels, thumbnails |
| `texturecache.js` | Pre-painted card textures for the zoomed-out mosaic |
| `imagecache.js` | Off-thread thumbnail decode, byte-budgeted LRU |
| `controls.js` | Smooth zoom, drag inertia, fly in/out, hover, keys |
| `timelinestrip.js` | The calendar strip under the canvas |
| `describe.js` | Plain-data description of a node for the info panel |
| `viewport.js` · `lod.js` · `lru.js` | Transform, level names, caches |
| `index.js` | `mountTimeCanvas()` + the dirty-driven frame loop |
| `build.js` | Bundles all of it into one browser-loadable file |

## How it gets the look

**Box size is decoupled from text size.** A card's area grows with the square
root of its length, clamped to 0.35–8× a typical card, and each card then picks
its own font scale so its whole text fits (`fitCard`). The earlier rule — area
equals text area — gave one 38k-character paste 8% of the canvas; now the
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
set from the smallest text on the canvas, so any clip can be zoomed to ≥ 7 px.

## What kind of clip it is

The type stored at capture time was unreliable. In real history, 81 of the 245
clips stored as "code" were chats, prompts, plans and reports — and ~37 more
were terminal sessions filed as Other code, JSON or SQL. `classify.js` decides
in this order:

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
is stored and what is shown agree. `node scratch/verify-classify.js` checks both
against synthetic examples of every case above.

Known gap: nested YAML (`services:` → `web:` → `image: nginx`) is not recognised
as config; it shows as Other code, as it always did.

## Controls

| | |
| --- | --- |
| scroll / pinch | smooth zoom toward the cursor |
| drag | pan, with inertia |
| click | select a clip |
| double-click | fly into the box under the cursor |
| right-click / Backspace | fly back out one level |
| F / Home | fit everything |
| + / − · arrows | zoom · pan |

The timeline strip lights the days currently on screen; click a day to fly to it.

## Verify

```bash
node scratch/verify-timecanvas-2d.js --clips=20000
npx electron scratch/verify-app.js --perf --shots=out
```

The first runs on plain Node: wrapping is exact and lossless, no boxes overlap,
clips are in copy order, and — for every card — the full text fits at its own
font scale, columns have a readable shape, no card is a sliver, no card
dominates, and the smallest text is reachable at max zoom. Measured at 20,000
clips: 539 ms layout, worst card aspect 7.8:1, smallest text 12.9% at 8× zoom,
largest card 0.13% of the canvas.

The second drives the real app against a **copy** of your database, at three
zoom levels, and writes screenshots. It renders offscreen, because a hidden
window stops producing frames and `capturePage` returns a stale one.

## Demo

```bash
node demo/serve.js
```

Open <http://localhost:8790> and pick up to 40,000 synthetic clips.

## Rebuild the bundle after editing any module

The renderer runs under `contextIsolation`, so it loads a bundle, not modules:

```bash
node src/renderer/canvas/build.js src/renderer/timecanvas.bundle.js
node src/renderer/canvas/build.js demo/timecanvas.bundle.js
```

## Notes

- `created_at` is INTEGER Unix **seconds**; `layout.toDate` handles that.
- Container keys are full paths (`root/y2026/m9/d5/h12`) so the current-hour
  marker lights exactly one hour, not the same hour on every day.
- The page CSP is `style-src 'self'`: set colours through `element.style`, never
  as `style="…"` in HTML strings, or they are silently dropped.
