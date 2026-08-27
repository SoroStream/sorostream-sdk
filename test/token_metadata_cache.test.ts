/**
 * Tests for issue #203: in-memory TokenMetadataCache for SAC name/symbol/decimals.
 *
 * - Second call for the same token is served from cache without an RPC request.
 * - Cache expires after TTL and re-fetches on next access.
 * - clearTokenCache() without argument clears all entries.
 * - Cache is per-client-instance and not shared between instances.
 * - Cache hit, cache miss, and TTL expiry are all covered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const USDC_TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const EURC_TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeClient(tokenMetadataTtlMs?: number) {
  return new SoroStreamClient({
    network: 'testnet',
    contractId: VALID_CONTRACT,
    walletAdapter: makeAdapter(),
    tokenMetadataTtlMs,
  });
}

/** Simulation success response for a single view-function return value. */
function viewResult(value: unknown): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    result: { retval: nativeToScVal(value) },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

/** Mocks simulateOp to answer name/symbol/decimals in that call order. */
function mockUsdcMetadata(client: SoroStreamClient) {
  return vi
    .spyOn(client as any, 'simulateOp')
    .mockResolvedValueOnce(viewResult('USD Coin'))
    .mockResolvedValueOnce(viewResult('USDC'))
    .mockResolvedValueOnce(viewResult(7));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('#203 getTokenMetadata', () => {
  it('fetches and returns name/symbol/decimals', async () => {
    const client = makeClient();
    mockUsdcMetadata(client);

    const metadata = await client.getTokenMetadata(USDC_TOKEN);

    expect(metadata).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 7 });
  });

  it('cache hit: second call is served from cache without another RPC request', async () => {
    const client = makeClient();
    const simulateSpy = mockUsdcMetadata(client);

    await client.getTokenMetadata(USDC_TOKEN);
    expect(simulateSpy).toHaveBeenCalledTimes(3); // name + symbol + decimals

    const second = await client.getTokenMetadata(USDC_TOKEN);
    expect(second).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 7 });
    expect(simulateSpy).toHaveBeenCalledTimes(3); // no additional RPC calls
  });

  it('cache miss: a different token address triggers its own RPC calls', async () => {
    const client = makeClient();
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7))
      .mockResolvedValueOnce(viewResult('Euro Coin'))
      .mockResolvedValueOnce(viewResult('EURC'))
      .mockResolvedValueOnce(viewResult(6));

    const usdc = await client.getTokenMetadata(USDC_TOKEN);
    const eurc = await client.getTokenMetadata(EURC_TOKEN);

    expect(usdc).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 7 });
    expect(eurc).toEqual({ name: 'Euro Coin', symbol: 'EURC', decimals: 6 });
    expect(simulateSpy).toHaveBeenCalledTimes(6);
  });

  it('concurrent calls for the same token share a single in-flight request', async () => {
    const client = makeClient();
    const simulateSpy = mockUsdcMetadata(client);

    const [a, b] = await Promise.all([
      client.getTokenMetadata(USDC_TOKEN),
      client.getTokenMetadata(USDC_TOKEN),
    ]);

    expect(a).toEqual(b);
    expect(simulateSpy).toHaveBeenCalledTimes(3); // not 6
  });

  it('TTL expiry: re-fetches on next access after the cache entry expires', async () => {
    vi.useFakeTimers();
    const client = makeClient(1_000); // 1s TTL
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7))
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7));

    await client.getTokenMetadata(USDC_TOKEN);
    expect(simulateSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1_500);

    const afterExpiry = await client.getTokenMetadata(USDC_TOKEN);
    expect(afterExpiry).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 7 });
    expect(simulateSpy).toHaveBeenCalledTimes(6);
  });

  it('defaults to a 10 minute TTL when tokenMetadataTtlMs is not set', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const simulateSpy = mockUsdcMetadata(client);

    await client.getTokenMetadata(USDC_TOKEN);
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000); // 9 minutes — still fresh
    await client.getTokenMetadata(USDC_TOKEN);

    expect(simulateSpy).toHaveBeenCalledTimes(3); // still cached
  });
});

describe('#203 clearTokenCache', () => {
  it('clears a single token when an address is given', async () => {
    const client = makeClient();
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7))
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7));

    await client.getTokenMetadata(USDC_TOKEN);
    client.clearTokenCache(USDC_TOKEN);
    await client.getTokenMetadata(USDC_TOKEN);

    expect(simulateSpy).toHaveBeenCalledTimes(6);
  });

  it('without an argument clears all entries', async () => {
    const client = makeClient();
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7))
      .mockResolvedValueOnce(viewResult('Euro Coin'))
      .mockResolvedValueOnce(viewResult('EURC'))
      .mockResolvedValueOnce(viewResult(6))
      .mockResolvedValueOnce(viewResult('USD Coin'))
      .mockResolvedValueOnce(viewResult('USDC'))
      .mockResolvedValueOnce(viewResult(7))
      .mockResolvedValueOnce(viewResult('Euro Coin'))
      .mockResolvedValueOnce(viewResult('EURC'))
      .mockResolvedValueOnce(viewResult(6));

    await client.getTokenMetadata(USDC_TOKEN);
    await client.getTokenMetadata(EURC_TOKEN);
    expect(simulateSpy).toHaveBeenCalledTimes(6);

    client.clearTokenCache();

    await client.getTokenMetadata(USDC_TOKEN);
    await client.getTokenMetadata(EURC_TOKEN);
    expect(simulateSpy).toHaveBeenCalledTimes(12);
  });
});

describe('#203 cache isolation between client instances', () => {
  it('is not shared between separate SoroStreamClient instances', async () => {
    const clientA = makeClient();
    const clientB = makeClient();

    mockUsdcMetadata(clientA);
    const simulateSpyB = mockUsdcMetadata(clientB);

    await clientA.getTokenMetadata(USDC_TOKEN);
    // clientB has never fetched this token, so it must hit the RPC too.
    await clientB.getTokenMetadata(USDC_TOKEN);

    expect(simulateSpyB).toHaveBeenCalledTimes(3);
  });
});
