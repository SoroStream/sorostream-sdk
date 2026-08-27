/**
 * A tiny, dependency-free Observable implementation that is fully
 * interoperable with RxJS (issue #423).
 *
 * `SoroStreamObservable` implements the ECMAScript Observable interop
 * protocol (`Symbol.observable` / `"@@observable"`), which is exactly what
 * RxJS's `from()` looks for. That means an observable returned by
 * {@link SoroStreamClient.observeStream} can be piped through the full RxJS
 * operator set and combined with any other observable:
 *
 * ```ts
 * import { from, combineLatest } from "rxjs";
 * import { map, distinctUntilChanged } from "rxjs/operators";
 *
 * const stream$ = from(client.observeStream("42"));
 * combineLatest([stream$, from(client.observeClaimable("42"))])
 *   .pipe(map(([stream, claimable]) => ({ status: stream.status, claimable })))
 *   .subscribe(console.log);
 * ```
 *
 * RxJS is intentionally **not** a dependency of this SDK — consumers who
 * don't use reactive programming pay nothing for this feature, and consumers
 * who do can bring whichever RxJS version they already have (`^6`, `^7`, and
 * `^8` all consume the interop protocol identically).
 */

/** Something that can be torn down. */
export interface Unsubscribable {
  unsubscribe(): void;
}

/** Handle returned by {@link SoroStreamObservable.subscribe}. */
export interface Subscription extends Unsubscribable {
  /** `true` once the subscription has been unsubscribed, errored, or completed. */
  readonly closed: boolean;
}

/** Consumer of the values produced by an observable. */
export interface Observer<T> {
  next?: (value: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/** Observer as seen by a producer: every callback is guaranteed to exist. */
export interface SubscriberSink<T> {
  next: (value: T) => void;
  error: (error: unknown) => void;
  complete: () => void;
  /** `true` once the sink has been closed and further emissions are ignored. */
  readonly closed: boolean;
}

/** Teardown returned by a producer function. */
export type Teardown = (() => void) | Unsubscribable | void;

/** Producer function invoked once per subscription. */
export type SubscribeFn<T> = (sink: SubscriberSink<T>) => Teardown;

/**
 * The interop symbol used by RxJS (`Symbol.observable` when the runtime or a
 * polyfill provides it, otherwise the well-known `"@@observable"` string key).
 */
export const observableSymbol: symbol | string =
  typeof Symbol === 'function' && (Symbol as unknown as { observable?: symbol }).observable
    ? (Symbol as unknown as { observable: symbol }).observable
    : '@@observable';

const NOOP = (): void => {};

function toTeardownFn(teardown: Teardown): () => void {
  if (typeof teardown === 'function') return teardown;
  if (teardown && typeof teardown.unsubscribe === 'function') {
    return () => teardown.unsubscribe();
  }
  return NOOP;
}

/**
 * Minimal cold Observable with RxJS interop.
 *
 * Each call to {@link SoroStreamObservable.subscribe} invokes the producer
 * function again (cold semantics), matching `new Observable()` in RxJS. Use
 * {@link shareLatest} for a hot, reference-counted variant that shares one
 * producer between subscribers and replays the most recent value.
 */
export class SoroStreamObservable<T> {
  constructor(private readonly producer: SubscribeFn<T>) {}

  /**
   * Subscribes to the observable.
   *
   * Accepts either a partial {@link Observer} or the RxJS-style positional
   * `(next, error, complete)` callbacks.
   */
  subscribe(
    observerOrNext?: Observer<T> | ((value: T) => void) | null,
    error?: ((error: unknown) => void) | null,
    complete?: (() => void) | null,
  ): Subscription {
    const observer: Observer<T> =
      typeof observerOrNext === 'function'
        ? {
            next: observerOrNext,
            ...(error ? { error } : {}),
            ...(complete ? { complete } : {}),
          }
        : (observerOrNext ?? {});

    let closed = false;
    let teardown: (() => void) | null = null;
    let teardownRan = false;

    const runTeardown = (): void => {
      if (teardownRan) return;
      teardownRan = true;
      const fn = teardown;
      teardown = null;
      try {
        fn?.();
      } catch {
        // A failing teardown must never mask the reason we are unsubscribing.
      }
    };

    const sink: SubscriberSink<T> = {
      get closed() {
        return closed;
      },
      next: (value: T) => {
        if (closed) return;
        try {
          observer.next?.(value);
        } catch (err) {
          // A throwing consumer terminates only its own subscription.
          closed = true;
          runTeardown();
          reportUncaught(observer, err);
        }
      },
      error: (err: unknown) => {
        if (closed) return;
        closed = true;
        runTeardown();
        reportUncaught(observer, err);
      },
      complete: () => {
        if (closed) return;
        closed = true;
        runTeardown();
        try {
          observer.complete?.();
        } catch {
          // Ignore consumer errors raised during completion.
        }
      },
    };

    try {
      teardown = toTeardownFn(this.producer(sink));
    } catch (err) {
      sink.error(err);
    }

    // A producer that completed synchronously has already torn itself down.
    if (closed) runTeardown();

    return {
      get closed() {
        return closed;
      },
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        runTeardown();
      },
    };
  }

  /**
   * Applies a chain of plain functions to this observable, mirroring RxJS's
   * `pipe`. Any function of the form `(source) => result` works, so custom
   * operators compose without importing RxJS.
   */
  pipe(): SoroStreamObservable<T>;
  pipe<A>(op1: (source: SoroStreamObservable<T>) => A): A;
  pipe<A, B>(op1: (source: SoroStreamObservable<T>) => A, op2: (source: A) => B): B;
  pipe<A, B, C>(
    op1: (source: SoroStreamObservable<T>) => A,
    op2: (source: A) => B,
    op3: (source: B) => C,
  ): C;
  pipe<A, B, C, D>(
    op1: (source: SoroStreamObservable<T>) => A,
    op2: (source: A) => B,
    op3: (source: B) => C,
    op4: (source: C) => D,
  ): D;
  pipe(...operators: Array<(source: never) => unknown>): unknown {
    return (operators as Array<(source: unknown) => unknown>).reduce<unknown>(
      (acc, op) => op(acc),
      this,
    );
  }

  /** Maps every emitted value through `project`. */
  map<R>(project: (value: T, index: number) => R): SoroStreamObservable<R> {
    return new SoroStreamObservable<R>((sink) => {
      let index = 0;
      const sub = this.subscribe({
        next: (value) => {
          try {
            sink.next(project(value, index++));
          } catch (err) {
            sink.error(err);
          }
        },
        error: (err) => sink.error(err),
        complete: () => sink.complete(),
      });
      return () => sub.unsubscribe();
    });
  }

  /** Emits only the values for which `predicate` returns `true`. */
  filter(predicate: (value: T, index: number) => boolean): SoroStreamObservable<T> {
    return new SoroStreamObservable<T>((sink) => {
      let index = 0;
      const sub = this.subscribe({
        next: (value) => {
          try {
            if (predicate(value, index++)) sink.next(value);
          } catch (err) {
            sink.error(err);
          }
        },
        error: (err) => sink.error(err),
        complete: () => sink.complete(),
      });
      return () => sub.unsubscribe();
    });
  }

  /** Resolves with the first emitted value, rejecting on error or empty completion. */
  firstValue(): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const sub = this.subscribe({
        next: (value) => {
          settled = true;
          resolve(value);
          // Defer so the producer is never torn down re-entrantly.
          queueTask(() => sub.unsubscribe());
        },
        error: (err) => {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
        complete: () => {
          if (!settled) reject(new Error('Observable completed without emitting a value'));
        },
      });
    });
  }

  /**
   * Returns itself, satisfying the Observable interop protocol consumed by
   * RxJS's `from()`, `zen-observable`, and any other spec-compliant library.
   *
   * The same function is installed under the runtime's observable symbol, so
   * `from(observable)` works without calling this explicitly.
   */
  asInterop(): this {
    return this;
  }
}

// Attach the interop method under the runtime's observable symbol. Declaring
// it as a computed class member is not possible for a `symbol | string` key
// under `useDefineForClassFields`, so it is installed on the prototype here.
Object.defineProperty(SoroStreamObservable.prototype, observableSymbol, {
  value: function observableInterop<T>(this: SoroStreamObservable<T>): SoroStreamObservable<T> {
    return this;
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

function reportUncaught<T>(observer: Observer<T>, error: unknown): void {
  if (observer.error) {
    try {
      observer.error(error);
      return;
    } catch {
      // fall through to the async report below
    }
  }
  // Match RxJS: an error with no handler must not be swallowed silently.
  queueTask(() => {
    console.error('[SoroStream] Unhandled observable error:', error);
  });
}

function queueTask(fn: () => void): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}

/** Options for {@link shareLatest}. */
export interface ShareLatestOptions {
  /** Called when the first subscriber connects. */
  onConnect?: () => void;
  /** Called when the last subscriber disconnects. */
  onDisconnect?: () => void;
}

/**
 * Turns a cold producer into a hot, reference-counted observable that shares a
 * single producer between all subscribers and replays the latest value to late
 * subscribers — the behaviour of RxJS's `share({ resetOnRefCountZero: true })`
 * combined with `shareReplay(1)`.
 *
 * This is what makes `observeStream()` safe to call from many components: one
 * poll loop feeds every subscriber, and it is torn down as soon as the last
 * one unsubscribes.
 */
export function shareLatest<T>(
  producer: SubscribeFn<T>,
  options: ShareLatestOptions = {},
): SoroStreamObservable<T> {
  const sinks = new Set<SubscriberSink<T>>();
  let teardown: (() => void) | null = null;
  let hasValue = false;
  let latest: T | undefined;
  let terminated: { kind: 'error'; error: unknown } | { kind: 'complete' } | null = null;

  const reset = (): void => {
    const fn = teardown;
    teardown = null;
    hasValue = false;
    latest = undefined;
    terminated = null;
    if (fn) {
      fn();
      options.onDisconnect?.();
    }
  };

  const upstream: SubscriberSink<T> = {
    get closed() {
      return terminated !== null;
    },
    next: (value: T) => {
      if (terminated) return;
      hasValue = true;
      latest = value;
      for (const sink of Array.from(sinks)) sink.next(value);
    },
    error: (error: unknown) => {
      if (terminated) return;
      terminated = { kind: 'error', error };
      const current = Array.from(sinks);
      sinks.clear();
      for (const sink of current) sink.error(error);
      reset();
    },
    complete: () => {
      if (terminated) return;
      terminated = { kind: 'complete' };
      const current = Array.from(sinks);
      sinks.clear();
      for (const sink of current) sink.complete();
      reset();
    },
  };

  return new SoroStreamObservable<T>((sink) => {
    // Replay the most recent value so a component mounting later renders
    // immediately instead of waiting for the next poll.
    if (hasValue) sink.next(latest as T);
    if (sink.closed) return;

    sinks.add(sink);
    if (teardown === null) {
      options.onConnect?.();
      teardown = toTeardownFn(producer(upstream));
      // The producer may have terminated synchronously.
      if (terminated) return;
    }

    return () => {
      sinks.delete(sink);
      if (sinks.size === 0) reset();
    };
  });
}
