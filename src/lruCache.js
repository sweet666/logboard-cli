// A byte-budgeted LRU cache for log bodies.
//
// Debug logs routinely run to several megabytes, and the log list holds 100 of
// them, so an unbounded cache can pin hundreds of megabytes for the life of the
// session. This keeps the most recently used bodies and evicts the oldest once
// the budget is exceeded. It implements the subset of the Map interface the app
// actually uses (has/get/set/delete/clear/keys); it is not a full Map — there
// is no entries/values/forEach/iteration.

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/** Byte length of a cached value (strings are the only expected input). */
function sizeOf(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value == null) return 0;
  return Buffer.byteLength(String(value), 'utf8');
}

export class LruCache {
  /** @param {{maxBytes?: number}} [opts] */
  constructor({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    // Map preserves insertion order, so the first key is the least recently
    // used as long as every read re-inserts its entry.
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  has(key) {
    return this._map.has(key);
  }

  /** Get a value, marking it as most recently used. */
  get(key) {
    const entry = this._map.get(key);
    if (entry === undefined) return undefined;
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /** Insert a value, evicting the least recently used entries to fit. */
  set(key, value) {
    if (this._map.has(key)) this.delete(key);

    const size = sizeOf(value);
    // A single value larger than the whole budget is still worth returning to
    // the caller, but caching it would evict everything else for no gain.
    if (size > this.maxBytes) return this;

    // Store the measured size so eviction never re-measures a multi-MB string.
    this._map.set(key, { value, size });
    this.bytes += size;
    this._evict();
    return this;
  }

  delete(key) {
    const entry = this._map.get(key);
    if (entry === undefined) return false;
    this.bytes -= entry.size;
    this._map.delete(key);
    return true;
  }

  clear() {
    this._map.clear();
    this.bytes = 0;
  }

  keys() {
    return this._map.keys();
  }

  _evict() {
    while (this.bytes > this.maxBytes && this._map.size > 0) {
      const oldest = this._map.keys().next().value;
      this.delete(oldest);
    }
  }
}
