// ─── src/renderer/canvas/timelinestrip.js ────────────────────────────────────
// The time axis, drawn as a strip under the canvas.
//
// The treemap keeps everything in time order, but a treemap cannot show the
// calendar: a quiet week and a missing week look the same once the days are
// packed into boxes. This strip lays every calendar day from your first clip
// to your last side by side -- empty days included, so gaps in your history
// show as gaps -- with a bar for how much you copied that day.
//
// It also answers "where am I?": the days currently on the canvas are lit, so
// as you fly the highlighted band tracks you through time. Click a day to fly
// straight to it.
// ─────────────────────────────────────────────────────────────────────────────

const { mix, rgbCss, BG } = require("./classify");

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WHITE = [255, 255, 255];

function mountTimelineStrip(host, tc) {
  const canvas = document.createElement("canvas");
  canvas.className = "timeline-strip";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.cursor = "pointer";
  host.appendChild(canvas);

  const tip = document.createElement("div");
  tip.className = "timeline-tip";
  tip.hidden = true;
  host.appendChild(tip);

  const ctx = canvas.getContext("2d");
  let days = [];
  let maxCount = 1;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let hoverIdx = -1;
  let lastSig = "";

  const dayKey = (d) => d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();

  function rebuild() {
    days = [];
    const tree = tc.getTree();
    const found = [];
    if (tree) {
      for (const y of tree.children) {
        for (const m of y.children) {
          for (const d of m.children) {
            const t = d.time;
            found.push({ date: new Date(t.year, t.month - 1, t.day), node: d });
          }
        }
      }
    }

    if (found.length) {
      found.sort((a, b) => a.date - b.date);
      const byDay = new Map(found.map((f) => [dayKey(f.date), f.node]));
      const last = found[found.length - 1].date;
      // setDate steps calendar days, so this is DST-safe.
      for (let d = new Date(found[0].date); d <= last; d.setDate(d.getDate() + 1)) {
        const node = byDay.get(dayKey(d)) || null;
        let bar = null;
        let lit = null;
        if (node) {
          bar = rgbCss(mix(node.avgRgb, BG, 0.1));
          lit = rgbCss(mix(node.avgRgb, WHITE, 0.35));
        }
        days.push({ date: new Date(d), node, count: node ? node.count : 0, bar, lit });
      }
    }
    maxCount = days.reduce((m, d) => Math.max(m, d.count), 1);
    draw(true);
  }

  function sizeCanvas() {
    const r = host.getBoundingClientRect();
    const nw = Math.max(1, Math.floor(r.width));
    const nh = Math.max(1, Math.floor(r.height));
    const ndpr = window.devicePixelRatio || 1;
    if (nw === W && nh === H && ndpr === dpr) return false;
    W = nw;
    H = nh;
    dpr = ndpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    return true;
  }

  function draw(force) {
    const resized = sizeCanvas();
    const vp = tc.viewport;
    const view = vp.worldBounds();
    const sig = [view.x0, view.y0, view.x1, view.y1].map((v) => v.toFixed(1)).join(",") +
                "|" + hoverIdx + "|" + days.length;
    if (!force && !resized && sig === lastSig) return;
    lastSig = sig;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, W, H);
    if (!days.length) return;

    const n = days.length;
    const bw = W / n;
    const base = H - 16;
    const top = 6;
    const span = base - top;
    const sqrtMax = Math.sqrt(maxCount);
    let vFirst = -1;
    let vLast = -1;

    for (let i = 0; i < n; i++) {
      const d = days[i];
      const x = i * bw;
      if (!d.node) {
        ctx.fillStyle = "#18202a";
        ctx.fillRect(x, base - 1, Math.max(0.5, bw - 0.5), 1);
        continue;
      }
      const nd = d.node;
      const visible = !(nd.x > view.x1 || nd.y > view.y1 ||
                        nd.x + nd.w < view.x0 || nd.y + nd.h < view.y0);
      if (visible) {
        if (vFirst < 0) vFirst = i;
        vLast = i;
      }
      // sqrt, so a one-clip day is still a visible bar next to a 100-clip day.
      const h = Math.max(2, (Math.sqrt(d.count) / sqrtMax) * span);
      const inset = Math.min(1, bw * 0.15);
      ctx.fillStyle = visible ? d.lit : d.bar;
      ctx.fillRect(x + inset, base - h, Math.max(0.8, bw - inset * 2), h);
    }

    // The slice of time currently on the canvas.
    if (vFirst >= 0) {
      const x0 = vFirst * bw;
      const x1 = (vLast + 1) * bw;
      ctx.fillStyle = "rgba(111,168,220,0.10)";
      ctx.fillRect(x0, 0, x1 - x0, base);
      ctx.strokeStyle = "rgba(111,168,220,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), base - 1);
    }

    // Month boundaries.
    ctx.font = "10px system-ui, 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    let lastLabelX = -1e9;
    for (let i = 0; i < n; i++) {
      const d = days[i].date;
      if (i !== 0 && d.getDate() !== 1) continue;
      const x = Math.round(i * bw) + 0.5;
      ctx.fillStyle = "#2a3947";
      ctx.fillRect(x, 0, 1, base + 3);
      if (x - lastLabelX > 72) {
        ctx.fillStyle = "#7d93a6";
        ctx.fillText(MONTH_SHORT[d.getMonth()] + " " + d.getFullYear(), x + 3, base + 3);
        lastLabelX = x;
      }
    }

    // Today.
    const today = new Date();
    const ti = days.findIndex((d) => dayKey(d.date) === dayKey(today));
    if (ti >= 0) {
      ctx.fillStyle = "#39d98a";
      ctx.fillRect(ti * bw + bw / 2 - 1, 0, 2, base);
    }

    if (hoverIdx >= 0 && hoverIdx < n) {
      ctx.strokeStyle = "#e8f0f6";
      ctx.lineWidth = 1;
      ctx.strokeRect(hoverIdx * bw + 0.5, 0.5, Math.max(1, bw) - 1, base - 1);
    }
  }

  function idxAt(e) {
    if (!days.length) return -1;
    const r = canvas.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * days.length);
    return Math.max(0, Math.min(days.length - 1, i));
  }

  /** Nearest day that actually has clips, searching outward. */
  function nearestWithClips(i) {
    for (let k = 0; k < days.length; k++) {
      if (days[i - k] && days[i - k].node) return i - k;
      if (days[i + k] && days[i + k].node) return i + k;
    }
    return -1;
  }

  function onMove(e) {
    const i = idxAt(e);
    if (i !== hoverIdx) { hoverIdx = i; draw(true); }
    if (i < 0) { tip.hidden = true; return; }
    const d = days[i];
    tip.textContent = WEEKDAY[d.date.getDay()] + " " + d.date.getDate() + " " +
      MONTH_SHORT[d.date.getMonth()] + " " + d.date.getFullYear() + "  ·  " +
      (d.count ? d.count + (d.count === 1 ? " clip" : " clips") : "nothing copied");
    tip.hidden = false;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const tw = tip.offsetWidth || 180;
    tip.style.left = Math.max(4, Math.min(r.width - tw - 4, x - tw / 2)) + "px";
  }

  function onLeave() {
    hoverIdx = -1;
    tip.hidden = true;
    draw(true);
  }

  function onClick(e) {
    const i = nearestWithClips(idxAt(e));
    if (i >= 0) tc.flyTo(days[i].node);
  }

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);
  canvas.addEventListener("click", onClick);

  const ro = new ResizeObserver(() => draw(true));
  ro.observe(host);
  const offFrame = tc.onFrame(() => draw(false));
  const offData = tc.onData(() => rebuild());
  rebuild();

  return {
    rebuild,
    draw: () => draw(true),
    destroy() {
      ro.disconnect();
      offFrame();
      offData();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.remove();
      tip.remove();
    },
  };
}

module.exports = { mountTimelineStrip };
