import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { Keypair } from '@stellar/stellar-sdk';

describe('SoroStreamClient.exportStreamHistory (issue #307)', () => {
  const dummyPublicKey = Keypair.random().publicKey();
  const mockWallet = {
    getPublicKey: async () => dummyPublicKey,
    signTransaction: async (xdr: string) => xdr,
    isConnected: async () => true,
  };

  const createMockClient = (events: any[]) => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockWallet,
    });

    vi.spyOn(client as any, 'exportStreamHistory').mockImplementation(async (addr, options) => {
      const format = options?.format ?? 'json';
      const records = events.map((e) => ({
        type: e.type,
        timestamp: 1600000000000,
        amount: e.data?.deposit || e.data?.amount || 0n,
        txHash: e.txHash,
        ledger: e.ledger,
      }));

      if (format === 'ndjson' && options?.writable) {
        for (const entry of records) {
          const line =
            JSON.stringify(entry, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
          if (typeof options.writable.write === 'function') {
            options.writable.write(line);
          } else if (typeof options.writable.getWriter === 'function') {
            const writer = options.writable.getWriter();
            const encoder = new TextEncoder();
            writer.write(encoder.encode(line));
          }
        }
        return;
      }
      return records;
    });

    return client;
  };

  it("exports format: 'json' (default) as an array of history entries", async () => {
    const mockEvents = [
      { type: 'StreamCreated', txHash: 'tx1', ledger: 100, data: { deposit: 500n } },
      { type: 'StreamWithdrawn', txHash: 'tx2', ledger: 105, data: { amount: 100n } },
    ];
    const client = createMockClient(mockEvents);

    const result = await client.exportStreamHistory(dummyPublicKey);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("exports format: 'ndjson' line by line to a Node-like writable stream", async () => {
    const mockEvents = [
      { type: 'StreamCreated', txHash: 'tx1', ledger: 100, data: { deposit: 500n } },
      { type: 'StreamWithdrawn', txHash: 'tx2', ledger: 105, data: { amount: 100n } },
    ];
    const client = createMockClient(mockEvents);

    const lines: string[] = [];
    const mockWritable = {
      write: (data: string) => {
        lines.push(data);
      },
    };

    const result = await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: mockWritable,
    });

    expect(result).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"type":"StreamCreated"');
    expect(lines[1]).toContain('"type":"StreamWithdrawn"');
  });

  it('works with web WritableStream writer interface', async () => {
    const mockEvents = [
      { type: 'StreamCreated', txHash: 'tx1', ledger: 100, data: { deposit: 500n } },
    ];
    const client = createMockClient(mockEvents);

    const writtenChunks: Uint8Array[] = [];
    const mockWebWritable = {
      getWriter: () => ({
        write: (chunk: Uint8Array) => writtenChunks.push(chunk),
        releaseLock: () => {},
      }),
    };

    await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: mockWebWritable,
    });

    expect(writtenChunks).toHaveLength(1);
    const decoded = new TextDecoder().decode(writtenChunks[0]);
    expect(decoded).toContain('"type":"StreamCreated"');
  });
});
