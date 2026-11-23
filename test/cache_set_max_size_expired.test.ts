import { Cache } from '../src/cache';
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('Cache.setMaxSize eviction (issue #967)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evicts an already-expired entry before a live LRU entry when shrinking', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const cache = new Cache<string, string>(60_000, 10);
    // Insert the live entry first so it is the least recently used of the two.
    cache.set('live', 'L', 60_000);
    cache.set('expired', 'E', 100);

    // Advance past the expired entry's TTL; 'live' is still fresh.
    t = 500;

    cache.setMaxSize(1);

    expect(cache.size).toBe(1);
    expect(cache.get('live')).toBe('L');
  });

  it('falls back to LRU eviction when no entries are expired', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const cache = new Cache<string, string>(60_000, 10);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    cache.setMaxSize(2);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('keeps all live entries when expired entries alone bring the size under the limit', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const cache = new Cache<string, string>(60_000, 10);
    cache.set('live1', 'x', 60_000);
    cache.set('live2', 'y', 60_000);
    cache.set('dead', 'z', 100);

    t = 500;

    cache.setMaxSize(2);

    expect(cache.size).toBe(2);
    expect(cache.get('live1')).toBe('x');
    expect(cache.get('live2')).toBe('y');
  });
});
