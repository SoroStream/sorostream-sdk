import type { Ref } from 'vue';
import type { Stream, StreamFilterCriteria, WithdrawParams } from '@sorostream/sdk';

/**
 * Minimal read surface required by the stream composables (issue #422).
 *
 * Both `SoroStreamClient` and `MockSoroStreamClient` satisfy this structurally,
 * so components can be unit-tested against the in-memory mock without a network
 * or a wallet.
 */
export interface StreamReaderLike {
  getStream(streamId: string, options?: { refresh?: boolean }): Promise<Stream>;
  /** Batch read added in issue #427 — used by `useStreamList` when available. */
  getStreams?(ids: string[]): Promise<Stream[]>;
  getStreamsBySender?(
    sender: string,
  ): Promise<Stream[] | { streams: Stream[]; cursor: string | null; hasMore: boolean }>;
  getStreamsByRecipient?(
    recipient: string,
    pagination?: undefined,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | { streams: Stream[]; cursor: string | null; hasMore: boolean }>;
  /** RxJS-compatible observable added in issue #423 — enables live updates. */
  observeStream?(
    streamId: string,
    options?: { intervalMs?: number },
  ): {
    subscribe(observer: {
      next?: (stream: Stream) => void;
      error?: (error: unknown) => void;
      complete?: () => void;
    }): { unsubscribe(): void };
  };
}

/** Minimal write surface required by {@link useWithdraw}. */
export interface WithdrawClientLike {
  withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }>;
}

/** A value, a ref, or a getter — mirrors Vue's own `MaybeRefOrGetter`. */
export type MaybeRefOrGetterLike<T> = T | Ref<T> | (() => T);

/** Options accepted by {@link useStream}. */
export interface UseStreamOptions {
  /**
   * Poll interval in milliseconds for live updates (default: `5000`).
   * Ignored when `live` is `false`.
   */
  intervalMs?: number;
  /**
   * When `true` (default), the composable subscribes to
   * `client.observeStream()` and keeps `stream` up to date. When `false`, the
   * stream is fetched once per `streamId` change.
   */
  live?: boolean;
  /** When `false`, nothing is fetched until `refresh()` is called (default: `true`). */
  immediate?: boolean;
}

/** Reactive state returned by {@link useStream}. */
export interface UseStreamReturn {
  /** The current stream, or `null` while loading or when unavailable. */
  stream: Ref<Stream | null>;
  /** `true` while a fetch is in flight. */
  loading: Ref<boolean>;
  /** The last error, or `null`. */
  error: Ref<Error | null>;
  /** Forces a fresh network read, bypassing the SDK read cache. */
  refresh: () => Promise<void>;
}

/** Source of the stream list requested by {@link useStreamList}. */
export type StreamListSource =
  | { ids: string[]; sender?: never; recipient?: never }
  | { sender: string; ids?: never; recipient?: never }
  | { recipient: string; ids?: never; sender?: never };

/** Options accepted by {@link useStreamList}. */
export interface UseStreamListOptions {
  /**
   * Poll interval in milliseconds. Defaults to `0`, which disables polling —
   * call `refresh()` (or change the source) to reload.
   */
  intervalMs?: number;
  /** When `false`, nothing is fetched until `refresh()` is called (default: `true`). */
  immediate?: boolean;
  /** Client-side filter applied to recipient queries (e.g. `{ activeOnly: true }`). */
  filter?: StreamFilterCriteria;
}

/** Reactive state returned by {@link useStreamList}. */
export interface UseStreamListReturn {
  /** The resolved streams (empty while loading or when unavailable). */
  streams: Ref<Stream[]>;
  /** `true` while a fetch is in flight. */
  loading: Ref<boolean>;
  /** The last error, or `null`. */
  error: Ref<Error | null>;
  /** Re-runs the query for the current source. */
  refresh: () => Promise<void>;
}

/** Reactive state returned by {@link useWithdraw}. */
export interface UseWithdrawReturn {
  /** Submits a withdrawal. Resolves with the transaction result. */
  withdraw: (
    streamIdOrParams: string | WithdrawParams,
  ) => Promise<{ txHash: string; amount: string }>;
  /** `true` while the transaction is being submitted. */
  submitting: Ref<boolean>;
  /** The last error, or `null`. */
  error: Ref<Error | null>;
  /** Hash of the last successful withdrawal, or `null`. */
  txHash: Ref<string | null>;
  /** Amount withdrawn by the last successful call (stroops as a string), or `null`. */
  amount: Ref<string | null>;
  /** Clears `error`, `txHash`, and `amount`. */
  reset: () => void;
}
