// Small bounded cache with per-entry expiry. Insertion order doubles as LRU
// order: reads refresh an entry, and the oldest entry is evicted first.
class TtlCache {
    constructor({ max = 1000, ttlMs = 60_000, now = () => Date.now() } = {}) {
        this.max = Math.max(1, Math.trunc(Number(max) || 1));
        this.ttlMs = Math.max(1, Number(ttlMs) || 1);
        this.now = now;
        this.entries = new Map();
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        while (this.entries.size > this.max) {
            this.entries.delete(this.entries.keys().next().value);
        }
        return this;
    }

    delete(key) {
        return this.entries.delete(key);
    }

    clear() {
        this.entries.clear();
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { TtlCache };
