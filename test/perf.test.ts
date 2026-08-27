/**
 * Performance regression tests (Issue #105).
 * Measures wall-clock time for createStream, getStream, and batchWithdraw
 * against a committed baseline. Fails if any operation exceeds baseline by >15%.
 *
 * Run via the separate `perf` CI job:
 *   vitest run test/perf.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const MOCK_RECIPIENT = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKJQFQ5ZQDXL5JGD7CNPR';

const THRESHOLD = 1.15; // 15% above baseline triggers failure
const WARMUP_RUNS = 3;
const MEASURED_RUNS = 10;

interface Baseline {
  createStream: number;
  getStream: number;
  batchWithdraw: number;
}

const baseline: Baseline = JSON.parse(
  readFileSync(join(import.meta.dirname ?? __dirname, 'perf-baseline.json'), 'utf8'),
);

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeClient(): SoroStreamClient {
  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: VALID_CONTRACT,
    walletAdapter: makeAdapter(),
  });

  // Mock all RPC I/O so we measure SDK overhead only
  (client as any).server = {
    getAccount: vi.fn().mockResolvedValue({ id: VALID_ACCOUNT, sequence: '1' }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: '' }, latestLedger: 1 }),
    prepareTransaction: vi.fn().mockImplementation((tx: unknown) => tx),
    sendTransaction: vi.fn().mockResolvedValue({ hash: 'txhash', status: 'SUCCESS' }),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', resultMetaXdr: '' }),
  };

  vi.spyOn(client as any, 'buildAndSubmit').mockResolvedValue('txhash');
  vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
    {
      id: '1',
      sender: VALID_ACCOUNT,
      recipient: MOCK_RECIPIENT,
      token: VALID_CONTRACT,
      deposit: 1_000_000n,
      flowRate: 100n,
      startTime: Math.floor(Date.now() / 1000) - 100,
      endTime: Math.floor(Date.now() / 1000) + 900,
      lastWithdrawTime: Math.floor(Date.now() / 1000) - 100,
      status: 'Active',
      autoRenew: false,
    },
  ]);
  vi.spyOn(client as any, 'simulateOp').mockResolvedValue({
    result: { retval: '' },
    latestLedger: 1,
  });
  vi.spyOn(client, 'executeBatch').mockResolvedValue('txhash_batch');
  vi.spyOn(client, 'getClaimable').mockResolvedValue(500n);

  return client;
}

/** Measures median wall-clock time (ms) for an async operation. */
async function measureMs(fn: () => Promise<void>): Promise<number> {
  // Warm up
  for (let i = 0; i < WARMUP_RUNS; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

describe('performance regression', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = makeClient();
  });

  it('createStream does not exceed baseline by 15%', async () => {
    const ms = await measureMs(() =>
      client
        .createStream({
          recipient: MOCK_RECIPIENT,
          token: VALID_CONTRACT,
          amount: 1_000_000n,
          durationSeconds: 3600,
          autoRenew: false,
        })
        .catch(() => {}),
    );
    const limit = baseline.createStream * THRESHOLD;
    console.log(
      `createStream: ${ms.toFixed(2)}ms (baseline ${baseline.createStream}ms, limit ${limit.toFixed(2)}ms)`,
    );
    expect(ms).toBeLessThanOrEqual(limit);
  });

  it('getStream does not exceed baseline by 15%', async () => {
    const ms = await measureMs(() => client.getStream('1').catch(() => {}));
    const limit = baseline.getStream * THRESHOLD;
    console.log(
      `getStream: ${ms.toFixed(2)}ms (baseline ${baseline.getStream}ms, limit ${limit.toFixed(2)}ms)`,
    );
    expect(ms).toBeLessThanOrEqual(limit);
  });

  it('batchWithdraw does not exceed baseline by 15%', async () => {
    const ms = await measureMs(() => client.batchWithdraw(['1', '2', '3'], 8).catch(() => {}));
    const limit = baseline.batchWithdraw * THRESHOLD;
    console.log(
      `batchWithdraw: ${ms.toFixed(2)}ms (baseline ${baseline.batchWithdraw}ms, limit ${limit.toFixed(2)}ms)`,
    );
    expect(ms).toBeLessThanOrEqual(limit);
  });
});
