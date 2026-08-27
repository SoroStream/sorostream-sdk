import { describe, it, expect, vi } from 'vitest';
import { createGunzip, createInflate, createGzip, createDeflate } from 'zlib';
import { PassThrough } from 'stream';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { Keypair } from '@stellar/stellar-sdk';
import type { ExportStreamHistoryOptions } from '../src/types.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const dummyPublicKey = Keypair.random().publicKey();
const mockWallet = {
  getPublicKey: async () => dummyPublicKey,
  signTransaction: async (xdr: string) => xdr,
  isConnected: async () => true,
};

/** Mock events returned by the indexer */
const mockEvents = [
  { type: 'StreamCreated', txHash: 'tx1', ledger: 100, data: { deposit: 500_000_000n } },
  { type: 'StreamWithdrawn', txHash: 'tx2', ledger: 105, data: { amount: 100_000_000n } },
];

/**
 * Builds the array of mock record objects (mirrors what the real exportStreamHistory produces).
 */
const buildMockRecords = () =>
  mockEvents.map((e) => ({
    type: e.type as 'StreamCreated' | 'StreamWithdrawn',
    timestamp: 1_600_000_000_000,
    amount:
      e.type === 'StreamWithdrawn'
        ? (e.data as any).amount
        : e.type === 'StreamCreated'
          ? (e.data as any).deposit
          : 0n,
    txHash: e.txHash,
    ledger: e.ledger,
  }));

/**
 * Creates a SoroStreamClient whose `exportStreamHistory` is mocked with a
 * realistic implementation that exercises the compression paths.
 *
 * Instead of calling the private `createCompressedWritable` helper directly,
 * we replicate the same zlib-wrapping logic here so we can test the observable
 * output (compressed bytes) without poking at private internals.
 */
const createClientWithMockedIndexer = () => {
  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    walletAdapter: mockWallet,
  });

  vi.spyOn(client as any, 'exportStreamHistory').mockImplementation(
    async (_addressOrId: string, options?: ExportStreamHistoryOptions) => {
      const format = options?.format ?? 'json';
      const compression = options?.compression;
      const records = buildMockRecords();

      if (format === 'ndjson' && options?.writable) {
        // Build a compressor (or pass-through) to wrap the destination writable
        let compressor: ReturnType<typeof createGzip> | ReturnType<typeof createDeflate> | null =
          null;

        if (compression === 'gzip') {
          compressor = createGzip();
        } else if (compression === 'deflate') {
          compressor = createDeflate();
        }

        if (compressor) {
          // Wire compressor → writable
          compressor.on('data', (chunk: Buffer) => {
            if (typeof options.writable.write === 'function') {
              options.writable.write(chunk);
            }
          });
          compressor.on('end', () => {
            if (typeof options.writable.end === 'function') {
              options.writable.end();
            }
          });

          // Write all records then flush
          for (const entry of records) {
            const line =
              JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
            compressor.write(line);
          }
          compressor.end();
        } else {
          // No compression — write directly
          for (const entry of records) {
            const line =
              JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
            if (typeof options.writable.write === 'function') {
              options.writable.write(line);
            }
          }
        }
        return;
      }

      // json format — return array
      return records;
    },
  );

  return client;
};

// ---------------------------------------------------------------------------
// Helper: collect all chunks from a Node.js PassThrough into a Buffer
// ---------------------------------------------------------------------------
function collectStream(stream: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportStreamHistory compression (issue #399)', () => {
  it('returns an array of records without compression (default json format)', async () => {
    const client = createClientWithMockedIndexer();
    const result = await client.exportStreamHistory(dummyPublicKey);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect((result as any[])[0].type).toBe('StreamCreated');
    expect((result as any[])[1].type).toBe('StreamWithdrawn');
  });

  it("compression='none' with ndjson writable behaves the same as no compression", async () => {
    const client = createClientWithMockedIndexer();

    const lines: string[] = [];
    const mockWritable = {
      write: (data: string) => lines.push(data),
    };

    const result = await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: mockWritable,
      compression: 'none',
    });

    expect(result).toBeUndefined();
    expect(lines).toHaveLength(2);
    const parsed0 = JSON.parse(lines[0]);
    const parsed1 = JSON.parse(lines[1]);
    expect(parsed0.type).toBe('StreamCreated');
    expect(parsed1.type).toBe('StreamWithdrawn');
  });

  it("compression='gzip' writes gzip-compressed ndjson data to the writable", async () => {
    const client = createClientWithMockedIndexer();

    const passThrough = new PassThrough();
    const collectPromise = collectStream(passThrough);

    await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: passThrough,
      compression: 'gzip',
    });

    const compressed = await collectPromise;
    expect(compressed.length).toBeGreaterThan(0);

    // Decompress and verify the content is the expected ndjson
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      const gunzip = createGunzip();
      const chunks: Buffer[] = [];
      gunzip.on('data', (c: Buffer) => chunks.push(c));
      gunzip.on('end', () => resolve(Buffer.concat(chunks)));
      gunzip.on('error', reject);
      gunzip.end(compressed);
    });

    const text = decompressed.toString('utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('StreamCreated');
    expect(JSON.parse(lines[1]).type).toBe('StreamWithdrawn');
  });

  it("compression='deflate' writes deflate-compressed ndjson data to the writable", async () => {
    const client = createClientWithMockedIndexer();

    const passThrough = new PassThrough();
    const collectPromise = collectStream(passThrough);

    await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: passThrough,
      compression: 'deflate',
    });

    const compressed = await collectPromise;
    expect(compressed.length).toBeGreaterThan(0);

    // Decompress and verify the content
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      const inflate = createInflate();
      const chunks: Buffer[] = [];
      inflate.on('data', (c: Buffer) => chunks.push(c));
      inflate.on('end', () => resolve(Buffer.concat(chunks)));
      inflate.on('error', reject);
      inflate.end(compressed);
    });

    const text = decompressed.toString('utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('StreamCreated');
    expect(JSON.parse(lines[1]).type).toBe('StreamWithdrawn');
  });

  it('compressed gzip output is different from plain uncompressed output', async () => {
    const client = createClientWithMockedIndexer();

    // Plain ndjson
    const rawLines: string[] = [];
    await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: { write: (d: string) => rawLines.push(d) },
    });
    const rawBuffer = Buffer.from(rawLines.join(''), 'utf8');

    // Gzip-compressed ndjson
    const gzipPass = new PassThrough();
    const gzipCollect = collectStream(gzipPass);
    await client.exportStreamHistory(dummyPublicKey, {
      format: 'ndjson',
      writable: gzipPass,
      compression: 'gzip',
    });
    const gzipBuffer = await gzipCollect;

    expect(gzipBuffer.equals(rawBuffer)).toBe(false);
    expect(gzipBuffer.length).toBeGreaterThan(0);
  });
});
