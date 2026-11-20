/**
 * Tests for issue #904: WebSocketTransportAdapter.subscribeEvents must call
 * onError exactly once — not once per failed attempt — after the reconnect
 * budget (maxAttempts) is exhausted.
 *
 * scheduleReconnect increments `attempts` and calls fail(err) only when
 * `attempts > maxAttempts`.  fail() calls close() and then onError(err)
 * exactly once.  These tests verify that behaviour by using a WebSocketFactory
 * mock that always throws on construction (so every connect attempt fails
 * immediately) and by advancing fake timers through the exponential backoff
 * delays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransportAdapter } from '../src/wsTransport.js';
import type { RpcTransportAdapter } from '../src/transport.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHttp(): RpcTransportAdapter {
  return {
    getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '' }),
  } as unknown as RpcTransportAdapter;
}

/**
 * Returns a WebSocketFactory that always throws, simulating a host
 * environment where every connection attempt fails synchronously.
 */
function alwaysFailFactory(): () => WebSocket {
  return () => {
    throw new Error('connection refused');
  };
}

function makeTransport(maxAttempts: number) {
  return new WebSocketTransportAdapter({
    wsUrl: 'wss://rpc.example',
    http: makeHttp(),
    reconnect: { maxAttempts, baseDelayMs: 100, maxDelayMs: 10_000 },
    webSocketFactory: alwaysFailFactory(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebSocketTransportAdapter.subscribeEvents — onError called exactly once (#904)', () => {
  /**
   * With maxAttempts=3, the reconnect sequence is:
   *   attempt 1: scheduleReconnect → delay 100 ms (baseDelayMs * 2^0)
   *   attempt 2: scheduleReconnect → delay 200 ms (baseDelayMs * 2^1)
   *   attempt 3: scheduleReconnect → delay 400 ms (baseDelayMs * 2^2)
   *   attempt 4: attempts(4) > maxAttempts(3) → fail() → onError called once
   *
   * connect() calls the factory, which throws, which is caught and routes to
   * scheduleReconnect.  Advancing the timer triggers the next connect().
   */
  it('calls onError exactly once after exhausting maxAttempts=3', () => {
    const transport = makeTransport(3);
    const errors: unknown[] = [];

    transport.subscribeEvents({ filters: [] }, () => {}, (err) => errors.push(err));

    // The first connect() runs immediately (synchronously via connect()).
    // Factory throws → scheduleReconnect(err) → attempts=1 ≤ 3 → schedule delay.
    expect(errors).toHaveLength(0);

    vi.advanceTimersByTime(100); // attempt 1 fires → factory throws → attempts=2
    expect(errors).toHaveLength(0);

    vi.advanceTimersByTime(200); // attempt 2 fires → factory throws → attempts=3
    expect(errors).toHaveLength(0);

    vi.advanceTimersByTime(400); // attempt 3 fires → factory throws → attempts=4 > 3 → fail()
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/connection refused/);
  });

  it('calls onError exactly once, not once per attempt, with maxAttempts=1', () => {
    const transport = makeTransport(1);
    const errors: unknown[] = [];

    transport.subscribeEvents({ filters: [] }, () => {}, (err) => errors.push(err));

    // attempt 1 → attempts=1 ≤ 1 → schedule delay
    expect(errors).toHaveLength(0);

    vi.advanceTimersByTime(100); // attempt 1 fires → attempts=2 > 1 → fail()
    expect(errors).toHaveLength(1);
  });

  it('calls onError exactly once with maxAttempts=5 after all 5 attempts fail', () => {
    const transport = makeTransport(5);
    const errors: unknown[] = [];

    transport.subscribeEvents({ filters: [] }, () => {}, (err) => errors.push(err));

    // Drive through all 5 attempt delays (100, 200, 400, 800, 1600 ms)
    for (const delay of [100, 200, 400, 800, 1600]) {
      expect(errors).toHaveLength(0);
      vi.advanceTimersByTime(delay);
    }

    // 6th call: attempts=6 > 5 → fail() fires, onError called once
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/connection refused/);
  });

  it('does not call onError when the subscription is cancelled before maxAttempts is reached', () => {
    const transport = makeTransport(3);
    const errors: unknown[] = [];

    const stop = transport.subscribeEvents(
      { filters: [] },
      () => {},
      (err) => errors.push(err),
    );

    // Advance through one failed attempt
    vi.advanceTimersByTime(100);
    expect(errors).toHaveLength(0);

    // Cancel before the remaining attempts fire
    stop();

    // Advance enough time for all remaining attempts to have fired if not cancelled
    vi.advanceTimersByTime(10_000);

    // onError must not have been called
    expect(errors).toHaveLength(0);
  });
});
