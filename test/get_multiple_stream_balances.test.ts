/**
 * Issue #445 — `getMultipleStreamBalances(ids[])`: batched balance reads.
 *
 * Covers the real client (single batched RPC call, TTL cache sharing, and
 * per-stream fallback), the offline `MockSoroStreamClient`, and the
 * `SoroStreamSandbox` call-tracking / scenario layer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { MockSoroStreamClient, SoroStreamSandbox } from '../src/mock.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function makeClient(): SoroStreamClient {
  const walletAdapter: WalletAdapter = {
    getPublicKey: vi.fn().mockResolvedValue('GABC1234567890'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
  return new SoroStreamClient({
    network: 'testnet',
    contractId: VALID_CONTRACT,
    walletAdapter,
  });
}

/** Raw RPC response with one entry per operation (mock/raw server shape). */
function rawBatchResponse(values: bigint[]): unknown {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    transactionData: 'AAAA',
    minResourceFee: '0',
    results: values.map((value) => ({
      auth: [],
      xdr: nativeToScVal(Number(value), { type: 'i128' }).toXDR('base64'),
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#445 getMultipleStreamBalances', () => {
  describe('MockSoroStreamClient', () => {
    it('returns one entry per stream with current balances', async () => {
      const mock = new MockSoroStreamClient();
      const a = (
        await mock.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 1_000_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;
      const b = (
        await mock.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 2_000_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;

      const result = await mock.getMultipleStreamBalances([a, b]);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ streamId: a, balance: 0n });
      expect(result[1]).toMatchObject({ streamId: b, balance: 0n });
    });

    it('de-duplicates while preserving first-seen order and resolves unknown streams to 0n', async () => {
      const mock = new MockSoroStreamClient();
      const a = (
        await mock.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 100_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;

      const result = await mock.getMultipleStreamBalances([a, 'missing', a, 'missing']);
      expect(result.map((r) => r.streamId)).toEqual([a, 'missing']);
      expect(result[0]!.balance).toBe(0n);
      expect(result[1]!.balance).toBe(0n);
    });

    it('returns an empty array for empty input', async () => {
      const mock = new MockSoroStreamClient();
      expect(await mock.getMultipleStreamBalances([])).toEqual([]);
    });

    it('reflects accrued balances after advanceTime', async () => {
      const mock = new MockSoroStreamClient();
      const a = (
        await mock.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 100_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;
      const b = (
        await mock.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 100_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;

      mock.advanceTime(a, 10);

      const result = await mock.getMultipleStreamBalances([a, b]);
      // flowRate = 100n stroops/sec → 10s accrued on `a`, 0s on `b`.
      expect(result[0]!.balance).toBe(1000n);
      expect(result[1]!.balance).toBe(0n);
    });
  });

  describe('SoroStreamSandbox (mock.ts)', () => {
    it('records calls and delegates to the default mock behaviour', async () => {
      const sandbox = new SoroStreamSandbox();
      const a = (
        await sandbox.createStream({
          recipient: 'GRECIPIENT',
          token: 'GUSDC',
          amount: 100_000n,
          durationSeconds: 1000,
          autoRenew: false,
        })
      ).streamId;

      const result = await sandbox.getMultipleStreamBalances([a]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ streamId: a, balance: 0n });

      sandbox.assertCalled('getMultipleStreamBalances', 1);
      sandbox.assertCalledWith('getMultipleStreamBalances', (args) => {
        return Array.isArray(args[0]) && args[0].includes(a);
      });
    });

    it('supports configureScenario overrides', async () => {
      const sandbox = new SoroStreamSandbox();
      sandbox.configureScenario('getMultipleStreamBalances', (ids: string[]) =>
        ids.map((id) => ({ streamId: id, balance: 42n })),
      );

      expect(await sandbox.getMultipleStreamBalances(['x', 'y'])).toEqual([
        { streamId: 'x', balance: 42n },
        { streamId: 'y', balance: 42n },
      ]);
    });

    it('is treated as a default operation in strict mode', async () => {
      const sandbox = new SoroStreamSandbox();
      sandbox.setUnexpectedCallPolicy('error');
      const result = await sandbox.getMultipleStreamBalances([]);
      expect(result).toEqual([]);
    });
  });

  describe('SoroStreamClient', () => {
    it('issues a single batched RPC call for multiple stream IDs', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi
        .spyOn(client as any, 'simulateOps')
        .mockResolvedValue(rawBatchResponse([10n, 20n, 30n]));

      const result = await client.getMultipleStreamBalances(['1', '2', '3']);

      expect(result).toEqual([
        { streamId: '1', balance: 10n },
        { streamId: '2', balance: 20n },
        { streamId: '3', balance: 30n },
      ]);
      // Exactly one RPC call, carrying one get_claimable op per stream ID.
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);
      expect((simulateOpsSpy.mock.calls[0]![0] as unknown[]).length).toBe(3);
    });

    it('de-duplicates input IDs before the batched call', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi
        .spyOn(client as any, 'simulateOps')
        .mockResolvedValue(rawBatchResponse([10n, 20n]));

      const result = await client.getMultipleStreamBalances(['1', '1', '2', '2']);

      expect(result).toEqual([
        { streamId: '1', balance: 10n },
        { streamId: '2', balance: 20n },
      ]);
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);
      expect((simulateOpsSpy.mock.calls[0]![0] as unknown[]).length).toBe(2);
    });

    it('serves cached balances without an additional RPC call', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi
        .spyOn(client as any, 'simulateOps')
        .mockResolvedValue({ result: { retval: nativeToScVal(500, { type: 'i128' }) } } as any);

      // Warm the shared TTL cache via a single-ID read.
      expect(await client.getClaimable('7')).toBe(500n);
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);

      // The batched read must be served from the cache — no new RPC call.
      const result = await client.getMultipleStreamBalances(['7']);
      expect(result).toEqual([{ streamId: '7', balance: 500n }]);
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);
    });

    it('warms the cache so a following getClaimable skips RPC', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi
        .spyOn(client as any, 'simulateOps')
        .mockResolvedValue(rawBatchResponse([10n]));

      await client.getMultipleStreamBalances(['1']);
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);

      simulateOpsSpy.mockClear();
      expect(await client.getClaimable('1')).toBe(10n);
      expect(simulateOpsSpy).not.toHaveBeenCalled();
    });

    it('joins in-flight getClaimable requests instead of issuing a duplicate RPC', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi
        .spyOn(client as any, 'simulateOps')
        .mockResolvedValue({ result: { retval: nativeToScVal(77, { type: 'i128' }) } } as any);

      const inFlight = client.getClaimable('9');
      const result = await client.getMultipleStreamBalances(['9']);

      expect(result).toEqual([{ streamId: '9', balance: 77n }]);
      await inFlight;
      // One RPC call shared by both reads.
      expect(simulateOpsSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to per-stream getClaimable when the batch simulation errors', async () => {
      const client = makeClient();
      let callCount = 0;
      vi.spyOn(client as any, 'simulateOps').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          // Batched simulation rejected/errored — e.g. stream not found.
          return { error: 'contract error: stream not found', id: '1', latestLedger: 1 };
        }
        // Individual getClaimable fallback calls.
        return { result: { retval: nativeToScVal(7, { type: 'i128' }) } } as any;
      });

      const result = await client.getMultipleStreamBalances(['1', '2']);

      expect(result).toEqual([
        { streamId: '1', balance: 7n },
        { streamId: '2', balance: 7n },
      ]);
      // 1 batched attempt + 1 fallback call per ID.
      expect(callCount).toBe(3);
    });

    it('falls back to per-stream getClaimable when the response shape is unexpected', async () => {
      const client = makeClient();
      let callCount = 0;
      vi.spyOn(client as any, 'simulateOps').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          // Raw shape with fewer results than requested IDs — unparseable.
          return rawBatchResponse([1n]);
        }
        return { result: { retval: nativeToScVal(5, { type: 'i128' }) } } as any;
      });

      const result = await client.getMultipleStreamBalances(['1', '2']);
      expect(result).toEqual([
        { streamId: '1', balance: 5n },
        { streamId: '2', balance: 5n },
      ]);
      expect(callCount).toBe(3);
    });

    it('clamps negative returned values to 0n', async () => {
      const client = makeClient();
      vi.spyOn(client as any, 'simulateOps').mockResolvedValue(rawBatchResponse([-5n]));

      const result = await client.getMultipleStreamBalances(['1']);
      expect(result).toEqual([{ streamId: '1', balance: 0n }]);
    });

    it('returns an empty array for empty input without any RPC call', async () => {
      const client = makeClient();
      const simulateOpsSpy = vi.spyOn(client as any, 'simulateOps');

      expect(await client.getMultipleStreamBalances([])).toEqual([]);
      expect(simulateOpsSpy).not.toHaveBeenCalled();
    });
  });
});
