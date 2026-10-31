import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookForwarder } from '../src/webhook.js';
import { jitterDelay } from '../src/internal.js';
import { ReplayTransport } from '../src/replayTransport.js';
import type { RpcTransportAdapter } from '../src/adapters.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { WriteRateLimiter } from '../src/writeRateLimiter.js';
import { RequestQueue } from '../src/request-queue.js';
import type { StreamEvent } from '../src/types.js';

describe('Issue #780: WebhookForwarder respects jitterDelay bounds and retry schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('jitterDelay produces values bounded within ±25% of raw delay across repeated samples', () => {
    const rawDelay = 1000;
    const minExpected = rawDelay * 0.75;
    const maxExpected = rawDelay * 1.25;

    for (let i = 0; i < 50; i++) {
      const jittered = jitterDelay(rawDelay);
      expect(jittered).toBeGreaterThanOrEqual(minExpected);
      expect(jittered).toBeLessThanOrEqual(maxExpected);
    }
  });

  it('WebhookForwarder retries up to maxRetries on persistent failure and terminates', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network failure'));
    const dummyClient = {
      subscribeEvents: vi.fn((_filter, callback) => {
        // Trigger event
        callback({
          type: 'created',
          streamId: 'stream-1',
          txHash: '0xabc',
          ledger: 100,
          timestamp: Date.now(),
          data: {},
        } as StreamEvent);
        return { unsubscribe: vi.fn() };
      }),
    };

    const forwarder = new WebhookForwarder(dummyClient as any, {
      url: 'https://webhook.example.com/events',
      retries: 3,
      retryDelayMs: 100,
      fetch: fetchMock as any,
    });

    forwarder.start();

    // Initial call + 3 retries = 4 calls total
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    forwarder.stop();
  });
});

describe('Issue #774: ReplayTransport.record preserves successful entries when baseTransport throws mid-recording', () => {
  it('preserves already-recorded interactions and allows toJSON/save after subsequent call failure', async () => {
    // `RpcTransportAdapter` has no generic `request(method, params)` entry
    // point — each RPC operation is its own named method (getAccount,
    // getLatestLedger, sendTransaction, ...), which is what `ReplayTransport.record`
    // actually wraps. Share one counter across the three named methods this
    // test exercises so the 3rd overall call is the one that throws.
    let callCount = 0;
    function nextResult(): { result: string } {
      callCount++;
      if (callCount === 3) {
        throw new Error('RPC connection dropped mid-session');
      }
      return { result: `success-${callCount}` };
    }
    const mockBaseTransport: RpcTransportAdapter = {
      serverURL: new URL('https://soroban-testnet.stellar.org'),
      async getAccount(): Promise<any> {
        return nextResult();
      },
      async getHealth(): Promise<any> {
        throw new Error('not used in this test');
      },
      async getLatestLedger(): Promise<any> {
        return nextResult();
      },
      async getTransaction(): Promise<any> {
        throw new Error('not used in this test');
      },
      async simulateTransaction(): Promise<any> {
        throw new Error('not used in this test');
      },
      async prepareTransaction(): Promise<any> {
        throw new Error('not used in this test');
      },
      async sendTransaction(): Promise<any> {
        return nextResult();
      },
      async getEvents(): Promise<any> {
        throw new Error('not used in this test');
      },
    };

    const recordingTransport = ReplayTransport.record(mockBaseTransport);
    const dummyTx = { toXDR: () => 'dummy-xdr' } as unknown as Parameters<
      RpcTransportAdapter['sendTransaction']
    >[0];

    // Call 1: success
    const res1 = await recordingTransport.getAccount('GABC');
    expect(res1).toEqual({ result: 'success-1' });

    // Call 2: success
    const res2 = await recordingTransport.getLatestLedger();
    expect(res2).toEqual({ result: 'success-2' });

    // Call 3: throws
    await expect(recordingTransport.sendTransaction(dummyTx)).rejects.toThrow(
      'RPC connection dropped mid-session',
    );

    // Assert that entries recorded prior to failure are preserved intact
    const entries = recordingTransport.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].method).toBe('getAccount');
    expect(entries[1].method).toBe('getLatestLedger');

    // toJSON works cleanly on the partial log
    const jsonOutput = recordingTransport.toJSON();
    expect(jsonOutput).toContain('getAccount');
    expect(jsonOutput).toContain('getLatestLedger');
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.entries).toHaveLength(2);
  });
});

describe('Issue #778: Comparative benchmark/workload test between RateLimiter, WriteRateLimiter, and RequestQueue', () => {
  it('exercises concurrent workload through RateLimiter to establish behavioral characteristics', async () => {
    const rateLimiter = new RateLimiter(2);
    let activeWorkers = 0;
    let maxObservedConcurrency = 0;

    const task = async (id: number) => {
      activeWorkers++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeWorkers--;
      return id;
    };

    const promises = [1, 2, 3, 4, 5].map((id) => rateLimiter.run(() => task(id)));
    const results = await Promise.all(promises);

    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
  });

  it('contrasts RateLimiter queuing with WriteRateLimiter backpressure rejection', async () => {
    // RateLimiter never rejects due to queue capacity — it queues tasks until resolved
    const rateLimiter = new RateLimiter(1);
    const p1 = rateLimiter.run(async () => 'ok1');
    const p2 = rateLimiter.run(async () => 'ok2');
    await expect(Promise.all([p1, p2])).resolves.toEqual(['ok1', 'ok2']);

    // In contrast, WriteRateLimiter applies backpressure and rejects when queue size is exceeded.
    // `queueSize` caps how many *waiting* operations are tolerated, not the
    // total call count — so with burst: 1 and queueSize: 1, the 1st call
    // consumes the burst allowance (resolves immediately), the 2nd exceeds it
    // and takes the single queue slot (waits, then resolves), and only a 3rd
    // call arriving while that slot is still occupied gets rejected. Fire all
    // three without awaiting in between so the 3rd genuinely overlaps the 2nd.
    const writeLimiter = new WriteRateLimiter({
      maxPerSecond: 10,
      burst: 1,
      queueSize: 1,
    });

    const w1 = writeLimiter.acquire('op');
    const w2 = writeLimiter.acquire('op');
    const w3 = writeLimiter.acquire('op');

    await expect(w3).rejects.toThrow();
    await expect(Promise.all([w1, w2])).resolves.toBeDefined();
  });
});
