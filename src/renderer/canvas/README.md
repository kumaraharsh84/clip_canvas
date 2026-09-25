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
