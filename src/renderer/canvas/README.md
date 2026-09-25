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
