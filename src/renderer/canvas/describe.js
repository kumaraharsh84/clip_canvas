// ─── src/renderer/canvas/describe.js ─────────────────────────────────────────
// Plain-data description of a node, for the info panel.
//
// The reference keeps a side panel that says where you are and what you are
// looking at -- the path to the hovered box and how much is inside it. This is
// the data half of that; the UI decides how to show it. Pure: no DOM, so it can
// be exercised from the node verifiers.
// ─────────────────────────────────────────────────────────────────────────────

const { CATEGORIES } = require("./classify");
const { toDate, clockLabel, MONTH_SHORT, CARD_FONT_PX, READABLE_PX } = require("./layout");

const KIND = ["all", "year", "month", "day", "hour", "clip"];

/** Breadcrumb from the year down to this node. */
function pathOf(n) {
  const parts = [];
  for (let p = n; p && p.depth >= 0; p = p.parent) {
    parts.unshift(p.clip ? p.timeLabel : p.label);
  }
  return parts;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function spanText(tsMin, tsMax) {
  if (!Number.isFinite(tsMin) || !Number.isFinite(tsMax)) return "";
  const a = new Date(tsMin);
  const b = new Date(tsMax);
  if (sameDay(a, b)) {
    return tsMin === tsMax ? clockLabel(a) : clockLabel(a) + " – " + clockLabel(b);
  }
  const d = (x) => x.getDate() + " " + MONTH_SHORT[x.getMonth()];
  return a.getFullYear() === b.getFullYear()
    ? d(a) + " – " + d(b) + " " + b.getFullYear()
    : d(a) + " " + a.getFullYear() + " – " + d(b) + " " + b.getFullYear();
}

function describeNode(n) {
  if (!n) return null;
  const path = pathOf(n);

  if (n.clip) {
    const c = n.clip;
    const text = c.content || "";
    const when = toDate(c.created_at);
    return {
      kind: "clip",
      id: c.id,
      type: c.type,
      path,
      title: n.headerText,
      category: n.cat.label,
      color: n.cat.ink,
      time: n.timeLabel,
      when: when.toLocaleString(undefined, {
        weekday: "short", day: "numeric", month: "short", year: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit",
      }),
      chars: c.type === "image" ? null : text.length,
      lines: n.fit ? n.fit.totalLines : null,
      columns: n.fit ? n.fit.columns : null,
      textScale: n.fit ? n.fit.scale : null,
      // The zoom at which this card's text becomes readable.
      readableAt: n.fit ? READABLE_PX / (CARD_FONT_PX * n.fit.scale) : null,
    };
  }

  const categories = Object.entries(n.cats || {})
    .map(([id, count]) => {
      const cat = CATEGORIES[id] || CATEGORIES.code;
      return { id, label: cat.label, color: cat.ink, count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    kind: KIND[n.depth + 1] || "group",
    path,
    title: n.labelLong || n.label,
    count: n.count,
    span: spanText(n.tsMin, n.tsMax),
    children: n.children.length,
    categories,
  };
}

module.exports = { describeNode, pathOf };
