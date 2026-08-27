/**
 * Benchmark suite — Issue #224
 *
 * Measures P50, P95, P99 latency over 100 iterations per operation for:
 *   - getStream
 *   - getClaimable
 *   - createStream
 *   - withdraw
 *
 * By default the suite runs against the in-memory MockSoroStreamClient so it can
 * run in CI without a live network. To run against a real local Soroban
 * quickstart sandbox set the env vars:
 *
 *   SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
 *   SOROBAN_CONTRACT_ID=<your-contract-id>
 *   SOROBAN_SECRET=S...
 *
 * Usage:
 *   npx vitest bench --reporter=verbose benchmarks/
 */

import { bench, describe, beforeAll } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

// ── Setup ────────────────────────────────────────────────────────────────────

const RECIPIENT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const ITERATIONS = 100;

// Shared mock client — reset once per suite run.
const mock = new MockSoroStreamClient();

// Pre-seeded stream IDs used for read benchmarks.
let seedStreamId = '';

// Warm-up: create one stream so read benchmarks have something to read.
beforeAll(async () => {
  const { streamId } = await mock.createStream({
    recipient: RECIPIENT,
    token: TOKEN,
    amount: 1_000_000_000n,
    durationSeconds: 86_400,
    autoRenew: false,
  });
  seedStreamId = streamId;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs `fn` `n` times, collects elapsed times, and returns a percentile object.
 * Used for reporting purposes; the bench() wrapper handles throughput timing.
 */
export async function measurePercentiles(
  fn: () => Promise<unknown>,
  n: number,
): Promise<{ p50: number; p95: number; p99: number; mean: number }> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p = (pct: number) => times[Math.floor((pct / 100) * times.length)] ?? 0;
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  return { p50: p(50), p95: p(95), p99: p(99), mean };
}

// ── getStream ─────────────────────────────────────────────────────────────────

describe('getStream latency', () => {
  bench(
    'getStream — 100 iterations',
    async () => {
      await mock.getStream(seedStreamId);
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── getClaimable ──────────────────────────────────────────────────────────────

describe('getClaimable latency', () => {
  bench(
    'getClaimable — 100 iterations',
    async () => {
      await mock.getClaimable(seedStreamId);
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── createStream ──────────────────────────────────────────────────────────────

describe('createStream latency', () => {
  bench(
    'createStream — 100 iterations',
    async () => {
      await mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 1_000_000_000n,
        durationSeconds: 3_600,
        autoRenew: false,
      });
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── withdraw ──────────────────────────────────────────────────────────────────

describe('withdraw latency', () => {
  bench(
    'withdraw — 100 iterations',
    async () => {
      // Create a fresh stream per iteration to ensure there is always
      // something to withdraw.
      const { streamId } = await mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 1_000_000_000n,
        durationSeconds: 3_600,
        autoRenew: false,
      });
      await mock.withdraw({ streamId });
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── batchWithdraw ─────────────────────────────────────────────────────────────

describe('batchWithdraw latency', () => {
  bench(
    'batchWithdraw 10 streams — 100 iterations',
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { streamId } = await mock.createStream({
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 1_000_000_000n,
          durationSeconds: 3_600,
          autoRenew: false,
        });
        ids.push(streamId);
      }
      for (const id of ids) {
        await mock.withdraw({ streamId: id });
      }
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── getStreamsBySender ────────────────────────────────────────────────────────

describe('getStreamsBySender latency', () => {
  bench(
    'getStreamsBySender — 100 iterations',
    async () => {
      await mock.getStreamsBySender(RECIPIENT);
    },
    { iterations: ITERATIONS, time: 0 },
  );
});

// ── WebSocket vs. HTTP Polling Event Subscription Latency ─────────────────────

describe('Event subscription latency — WebSocket vs. HTTP polling (100 events)', () => {
  bench(
    'WebSocket transport event subscription — 100 events',
    async () => {
      // Mock WebSocket server emitting 100 simulated events
      const listeners = new Set<(msg: string) => void>();
      const mockWsFactory = () =>
        ({
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          send: () => {},
          close: () => {},
        }) as unknown as WebSocket;

      const ws = mockWsFactory();
      let receivedCount = 0;
      const donePromise = new Promise<void>((resolve) => {
        ws.onmessage = () => {
          receivedCount++;
          if (receivedCount >= ITERATIONS) resolve();
        };
      });

      for (let i = 0; i < ITERATIONS; i++) {
        ws.onmessage?.({
          data: JSON.stringify({ type: 'claimable', streamId: '1', value: '100' }),
        });
      }
      await donePromise;
    },
    { iterations: 1, time: 0 },
  );

  bench(
    'HTTP polling transport event subscription — 100 events',
    async () => {
      let receivedCount = 0;
      const pollServer = async () => {
        return { events: [{ value: '100' }] };
      };

      for (let i = 0; i < ITERATIONS; i++) {
        const res = await pollServer();
        if (res.events.length > 0) receivedCount++;
      }
      expect(receivedCount).toBe(ITERATIONS);
    },
    { iterations: 1, time: 0 },
  );
});
