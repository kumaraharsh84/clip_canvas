// ─── src/renderer/canvas/lru.js ──────────────────────────────────────────────
// Cost-budgeted LRU. Budget is on COST, not entry count, because the things
// cached here vary by orders of magnitude: one 2 MB clip's wrapped lines must
// not be able to evict a thousand small ones, and a thousand small ones must
// not quietly add up to hundreds of MB.
// ─────────────────────────────────────────────────────────────────────────────

class LRU {
  constructor({ maxCost = 1_000_000, onEvict = null } = {}) {
    this.maxCost = maxCost;
    this.onEvict = onEvict;
    this.map = new Map(); // Map preserves insertion order = recency order here
    this.cost = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (e === undefined) { this.misses++; return undefined; }
    // Re-insert to move to the most-recent end.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key, value, cost = 1) {
    const prev = this.map.get(key);
    if (prev !== undefined) { this.cost -= prev.cost; this.map.delete(key); }
    this.map.set(key, { value, cost });
    this.cost += cost;
    this.trim();
    return value;
  }

  trim() {
    // Map iteration starts at the least-recently-used entry.
    while (this.cost > this.maxCost && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      const e = this.map.get(oldest);
      this.map.delete(oldest);
      this.cost -= e.cost;
      if (this.onEvict) this.onEvict(oldest, e.value);
    }
  }

  clear() {
    if (this.onEvict) for (const [k, e] of this.map) this.onEvict(k, e.value);
    this.map.clear();
    this.cost = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      cost: this.cost,
      maxCost: this.maxCost,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0,
    };
  }
}

module.exports = { LRU };
