/**
 * Injectable adapters for the browser-specific globals the SDK relies on by
 * default (`localStorage`, `WebSocket`, `fetch`). Pass overrides via
 * `SoroStreamClientOptions.adapters` (or the `createClient({ adapters })`
 * factory) to run the SDK in environments — like React Native — that don't
 * provide these globals, or to swap in a custom implementation.
 *
 * See `@sorostream/sdk-react-native` for ready-made React Native adapters.
 */

/** Minimal synchronous key-value storage contract, matching the Web Storage API. */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Constructs a `WebSocket`-compatible connection for the given URL. */
export type WebSocketFactory = (url: string, opts?: unknown) => WebSocket;

/** `fetch`-compatible request function. */
export type FetchAdapter = typeof fetch;

/** Overrides for the browser globals the SDK uses by default. */
export interface SoroStreamAdapters {
  /** Replaces `localStorage`. Used by the opt-in audit log feature. */
  storage?: StorageAdapter;
  /** Replaces `WebSocket`. Used by `watchClaimable`'s real-time subscription. */
  webSocketFactory?: WebSocketFactory;
  /** Replaces `fetch`. Used by federation resolution, price feeds, and webhook forwarding. */
  fetch?: FetchAdapter;
}

/** Returns a {@link StorageAdapter} backed by the global `localStorage`, or `null` if unavailable. */
export function getDefaultStorageAdapter(): StorageAdapter | null {
  if (typeof localStorage === 'undefined') return null;
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  };
}

/** Returns a {@link WebSocketFactory} backed by the global `WebSocket`, or `null` if unavailable. */
export function getDefaultWebSocketFactory(): WebSocketFactory | null {
  if (typeof WebSocket === 'undefined') return null;
  return (url, opts) =>
    opts
      ? new (WebSocket as unknown as new (u: string, o: unknown) => WebSocket)(url, opts)
      : new WebSocket(url);
}

/** Returns a {@link FetchAdapter} backed by the global `fetch`, or `null` if unavailable. */
export function getDefaultFetchAdapter(): FetchAdapter | null {
  return typeof fetch === 'undefined' ? null : fetch;
}
