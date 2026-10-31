/**
 * Tests for issue #795: createReactNativeAdapters should correctly handle
 * an AsyncStorageLike dependency that throws on get/set operations at runtime
 * (e.g. a device with corrupted native storage). The resulting StorageAdapter
 * must surface the error clearly to its own callers rather than crashing the
 * adapter-creation call itself.
 */
import { describe, it, expect, vi } from 'vitest';

import { createAsyncStorageAdapter, createReactNativeAdapters } from '../src/index.js';
import type { AsyncStorageLike } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an AsyncStorageLike mock where every operation throws. */
function makeThrowingAsyncStorage(message = 'Corrupted native storage'): AsyncStorageLike {
  return {
    getItem: vi.fn().mockRejectedValue(new Error(message)),
    setItem: vi.fn().mockRejectedValue(new Error(message)),
    removeItem: vi.fn().mockRejectedValue(new Error(message)),
  };
}

/** Creates a healthy, in-memory AsyncStorageLike. */
function makeHealthyAsyncStorage(): AsyncStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    removeItem: vi.fn(async (key: string) => void store.delete(key)),
  };
}

// ---------------------------------------------------------------------------
// createReactNativeAdapters — adapter-creation behaviour
// ---------------------------------------------------------------------------

describe('createReactNativeAdapters (#795) — adapter creation', () => {
  it('does NOT throw at creation time even when asyncStorage will throw on every op', () => {
    // The adapter must be created without error — storage errors only surface
    // when the caller later exercises the adapter (get/set/remove).
    expect(() =>
      createReactNativeAdapters({ asyncStorage: makeThrowingAsyncStorage() }),
    ).not.toThrow();
  });

  it('does NOT throw at creation time when asyncStorage is healthy', () => {
    expect(() =>
      createReactNativeAdapters({ asyncStorage: makeHealthyAsyncStorage() }),
    ).not.toThrow();
  });

  it('returns a storage adapter when asyncStorage is provided', () => {
    const adapters = createReactNativeAdapters({ asyncStorage: makeHealthyAsyncStorage() });
    expect(adapters.storage).toBeDefined();
    expect(typeof adapters.storage!.getItem).toBe('function');
    expect(typeof adapters.storage!.setItem).toBe('function');
    expect(typeof adapters.storage!.removeItem).toBe('function');
  });

  it('returns an adapters object with no storage when no asyncStorage is provided', () => {
    const adapters = createReactNativeAdapters();
    // Should not throw; storage is simply absent.
    expect(adapters.storage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createAsyncStorageAdapter — runtime error surfacing
// ---------------------------------------------------------------------------

describe('createAsyncStorageAdapter (#795) — runtime error surfacing', () => {
  // ---- setItem ---------------------------------------------------------------

  it('setItem: does NOT throw synchronously when the underlying storage throws', async () => {
    // The synchronous StorageAdapter.setItem must never throw — it only
    // updates the in-memory cache synchronously. Any async persistence error
    // is a background fire-and-forget; the SDK tolerates storage failures via
    // the best-effort contract.
    const throwing = makeThrowingAsyncStorage('disk full');
    const adapter = createAsyncStorageAdapter(throwing);

    // This must not throw synchronously.
    expect(() => adapter.setItem('key', 'value')).not.toThrow();
  });

  it('setItem: in-memory cache is updated immediately even when the async write fails', async () => {
    const throwing = makeThrowingAsyncStorage('disk full');
    const adapter = createAsyncStorageAdapter(throwing);

    adapter.setItem('foo', 'bar');

    // The synchronous cache must reflect the write immediately.
    expect(adapter.getItem('foo')).toBe('bar');

    // Allow the background setItem rejection to settle without propagating.
    await new Promise((r) => setTimeout(r, 0));

    // The value must still be readable from the in-memory cache.
    expect(adapter.getItem('foo')).toBe('bar');
  });

  it('setItem: the background async error does NOT propagate as an unhandled rejection', async () => {
    const throwing = makeThrowingAsyncStorage('write error');
    const adapter = createAsyncStorageAdapter(throwing);

    // Track unhandled rejections during this test (Node.js runtime).
    const unhandled: Error[] = [];
    const handler = (reason: Error) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    adapter.setItem('key', 'value');
    await new Promise((r) => setTimeout(r, 10));

    process.off('unhandledRejection', handler);

    // The background error must be swallowed, not propagate.
    expect(unhandled).toHaveLength(0);
  });

  // ---- removeItem ------------------------------------------------------------

  it('removeItem: does NOT throw synchronously when the underlying storage throws', async () => {
    const throwing = makeThrowingAsyncStorage();
    const adapter = createAsyncStorageAdapter(throwing);

    // Seed the cache so there is something to remove.
    adapter.setItem('key', 'value');
    expect(adapter.getItem('key')).toBe('value');

    // Must not throw synchronously.
    expect(() => adapter.removeItem('key')).not.toThrow();
  });

  it('removeItem: in-memory cache is cleared even when the async remove fails', async () => {
    const throwing = makeThrowingAsyncStorage('storage unavailable');
    const adapter = createAsyncStorageAdapter(throwing);

    adapter.setItem('key', 'to-remove');
    adapter.removeItem('key');

    // The synchronous cache must reflect the removal immediately.
    expect(adapter.getItem('key')).toBeNull();

    // Allow the background rejection to settle.
    await new Promise((r) => setTimeout(r, 0));

    // Still gone.
    expect(adapter.getItem('key')).toBeNull();
  });

  // ---- getItem / hydration ---------------------------------------------------

  it('getItem: returns null immediately on first access (before hydration)', () => {
    const throwing = makeThrowingAsyncStorage('read error');
    const adapter = createAsyncStorageAdapter(throwing);

    // Before hydration completes the cache is empty — null is the correct
    // "not yet known" result.
    expect(adapter.getItem('anything')).toBeNull();
  });

  it('getItem: returns null after hydration fails (best-effort, does not throw)', async () => {
    const throwing = makeThrowingAsyncStorage('read error');
    const adapter = createAsyncStorageAdapter(throwing);

    adapter.getItem('key'); // triggers background hydration
    await new Promise((r) => setTimeout(r, 0)); // let the hydration settle

    // After a failed hydration the key is still absent — null, not an error.
    expect(adapter.getItem('key')).toBeNull();
  });

  it('getItem: the background hydration error does NOT propagate as an unhandled rejection', async () => {
    const throwing = makeThrowingAsyncStorage('read fail');
    const adapter = createAsyncStorageAdapter(throwing);

    const unhandled: Error[] = [];
    const handler = (reason: Error) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    adapter.getItem('key');
    await new Promise((r) => setTimeout(r, 10));

    process.off('unhandledRejection', handler);

    expect(unhandled).toHaveLength(0);
  });

  // ---- happy path contrast ---------------------------------------------------

  it('happy path: setItem persists to the backing store when healthy', async () => {
    const healthy = makeHealthyAsyncStorage();
    const adapter = createAsyncStorageAdapter(healthy);

    adapter.setItem('hello', 'world');
    expect(adapter.getItem('hello')).toBe('world');

    await new Promise((r) => setTimeout(r, 0));
    expect(healthy.setItem).toHaveBeenCalledWith('hello', 'world');
  });

  it('happy path: removeItem removes from the backing store when healthy', async () => {
    const healthy = makeHealthyAsyncStorage();
    const adapter = createAsyncStorageAdapter(healthy);

    adapter.setItem('k', 'v');
    adapter.removeItem('k');
    expect(adapter.getItem('k')).toBeNull();

    await new Promise((r) => setTimeout(r, 0));
    expect(healthy.removeItem).toHaveBeenCalledWith('k');
  });

  it('happy path: getItem hydrates value from backing store on first access', async () => {
    const healthy = makeHealthyAsyncStorage();
    await (healthy as ReturnType<typeof makeHealthyAsyncStorage>).setItem('pre', 'seeded');

    const adapter = createAsyncStorageAdapter(healthy);

    // First sync read is null (pre-hydration).
    expect(adapter.getItem('pre')).toBeNull();

    // After hydration completes, the value is in cache.
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.getItem('pre')).toBe('seeded');
  });
});
