interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<K, V> {
  private store = new Map<K, CacheEntry<V>>();
  private defaultTtlMs: number;
  private maxSize: number;

  constructor(defaultTtlMs = 60_000, maxSize = 1_000) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU order on access
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // LRU eviction: remove the least recently used entry (first key in map)
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  setMaxSize(size: number): void {
    this.maxSize = size;
    while (this.store.size > this.maxSize) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      } else {
        break;
      }
    }
  }

  setTtl(ttlMs: number): void {
    this.defaultTtlMs = ttlMs;
  }

  get size(): number {
    return this.store.size;
  }
}
