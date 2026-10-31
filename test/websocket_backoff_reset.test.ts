/**
 * Issue #785: WebSocketTransportAdapter reconnect backoff — attempt counter
 * must reset to zero after a *successful reconnect* following prior failed
 * attempts, not just after the very first successful connection.
 *
 * This matters for long-running clients that experience multiple separate
 * disconnect/reconnect cycles: if the counter were never reset between
 * cycles the client would exhaust its maxAttempts budget after the second
 * cycle and fall back to HTTP polling prematurely.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { WebSocketTransportAdapter } from '../src/wsTransport.js';
import type { RpcTransportAdapter } from '../src/transport.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {}
}

function makeHttp(): RpcTransportAdapter {
  return {
    getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '' }),
  } as unknown as RpcTransportAdapter;
}

function makeTransport(http: RpcTransportAdapter, maxAttempts = 3) {
  return new WebSocketTransportAdapter({
    wsUrl: 'wss://rpc.example',
    http,
    reconnect: { maxAttempts, baseDelayMs: 100, maxDelayMs: 5_000 },
    webSocketFactory: () => new FakeSocket() as unknown as WebSocket,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebSocketTransportAdapter — backoff counter reset (#785)', () => {
  /**
   * Cycle 1: initial connect → fail once → succeed on second attempt.
   * Cycle 2: a subsequent disconnect from that "recovered" socket should
   * begin counting attempts from 0 again, giving the client the full
   * maxAttempts budget for the new cycle.
   */
  it('resets attempt counter to zero after a successful reconnect so subsequent cycles get the full budget', () => {
    const http = makeHttp();
    const transport = makeTransport(http, /* maxAttempts */ 3);

    const errors: unknown[] = [];
    const stop = transport.subscribeEvents(
      { filters: [] },
      () => {},
      (err) => errors.push(err),
    );

    // ── Cycle 1 ──────────────────────────────────────────────────────────────
    // Initial socket (attempt 0 → connect).
    const ws0 = FakeSocket.instances[0]!;
    expect(FakeSocket.instances).toHaveLength(1);

    // Trigger one failed reconnect attempt.
    ws0.onclose!(); // attempts becomes 1
    vi.advanceTimersByTime(100); // baseDelayMs * 2^0 = 100 ms
    expect(FakeSocket.instances).toHaveLength(2);

    // ws1 connects successfully — onopen must reset the counter.
    const ws1 = FakeSocket.instances[1]!;
    ws1.onopen!(); // ← should reset attempts to 0

    // ── Cycle 2 ──────────────────────────────────────────────────────────────
    // Now disconnect ws1.  If the counter was NOT reset, we'd only have
    // maxAttempts - 1 = 2 attempts left; with reset we have the full 3.
    ws1.onclose!(); // start of second cycle, attempts → 1

    vi.advanceTimersByTime(100); // attempt 1 delay (100 ms)
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.onclose!(); // attempt 2

    vi.advanceTimersByTime(200); // attempt 2 delay (200 ms)
    expect(FakeSocket.instances).toHaveLength(4);
    FakeSocket.instances[3]!.onclose!(); // attempt 3

    vi.advanceTimersByTime(400); // attempt 3 delay (400 ms)
    expect(FakeSocket.instances).toHaveLength(5);
    FakeSocket.instances[4]!.onclose!(); // attempts(4) > maxAttempts(3) → fail()

    // maxAttempts reached → onError is called (HTTP polling fallback).
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('WebSocket closed');

    stop();
  });

  /**
   * Regression: a subsequent disconnect after a clean reconnect must restart
   * the attempt counter from 0, not from where the previous cycle stopped.
   *
   * We assert this by confirming that maxAttempts NEW sockets are created
   * in the second cycle (3 sockets: ws2, ws3, ws4), proving the counter
   * started from 0 and not from a leftover value.
   */
  it('a second disconnect/reconnect cycle gets exactly maxAttempts fresh attempts', () => {
    const http = makeHttp();
    const transport = makeTransport(http, /* maxAttempts */ 2);

    const errors: unknown[] = [];
    transport.subscribeEvents(
      { filters: [] },
      () => {},
      (err) => errors.push(err),
    );

    // ── Cycle 1: connect, fail once, succeed ─────────────────────────────────
    const ws0 = FakeSocket.instances[0]!;
    ws0.onclose!();
    vi.advanceTimersByTime(100); // attempt 1 → ws1

    const ws1 = FakeSocket.instances[1]!;
    ws1.onopen!(); // reset counter

    // ── Cycle 2 ──────────────────────────────────────────────────────────────
    // With maxAttempts=2 and counter reset to 0 after ws1.onopen, cycle 2
    // gets exactly 2 reconnect sockets before `fail()` fires.
    const socketCountBeforeCycle2 = FakeSocket.instances.length; // 2
    ws1.onclose!();
    vi.advanceTimersByTime(100); // attempt 1 of cycle 2 → ws2
    FakeSocket.instances[FakeSocket.instances.length - 1]!.onclose!();

    vi.advanceTimersByTime(200); // attempt 2 of cycle 2 → ws3
    FakeSocket.instances[FakeSocket.instances.length - 1]!.onclose!();

    vi.advanceTimersByTime(400); // attempts(3) > maxAttempts(2) → fail(), no new socket

    // Cycle 2 created exactly maxAttempts (2) reconnect sockets.
    const socketsInCycle2 = FakeSocket.instances.length - socketCountBeforeCycle2;
    expect(socketsInCycle2).toBe(2); // 2 reconnect sockets before onError fires

    // HTTP fallback fires exactly once after the cycle 2 budget is spent.
    expect(errors).toHaveLength(1);
  });

  /**
   * Confirms fallback to HTTP polling still fires correctly when maxAttempts
   * is reached in a given cycle — not broken by any reset logic.
   */
  it('falls back to HTTP polling when maxAttempts is exhausted in a cycle', () => {
    const http = makeHttp();
    const transport = makeTransport(http, /* maxAttempts */ 2);

    const errors: unknown[] = [];
    transport.subscribeEvents(
      { filters: [] },
      () => {},
      (err) => errors.push(err),
    );

    const ws0 = FakeSocket.instances[0]!;
    ws0.onopen!(); // initial connect — reset to 0

    // Exhaust all attempts without a successful reconnect.
    ws0.onclose!();
    vi.advanceTimersByTime(100); // attempt 1
    FakeSocket.instances[1]!.onclose!();
    vi.advanceTimersByTime(200); // attempt 2
    FakeSocket.instances[2]!.onclose!();
    vi.advanceTimersByTime(400); // attempt 3 = maxAttempts+1 → fallback

    expect(errors).toHaveLength(1);
  });
});
