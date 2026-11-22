/**
 * Tests for issues #899, #901, #902, #903
 *
 * #899 — BatchBuilder.submit() continues running operations after one fails.
 * #901 — createSimplePriceFeed caches per (tokenAddress, displayCurrency) pair.
 * #902 — createSimplePriceFeed defaults to price 0 when the response lacks the token/currency.
 * #903 — createSimplePriceFeed uses a custom fetch adapter and forwards custom headers.
 */

import { describe, it, expect, vi } from 'vitest';
import { BatchBuilder } from '../src/batchBuilder.js';
import { createSimplePriceFeed } from '../src/priceFeed.js';
import type { FetchAdapter } from '../src/adapters.js';
import type { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { CreateStreamParams } from '../src/types.js';

const API_URL = 'https://prices.example/api';
const TOKEN = 'CTOKEN';

function mockFetch(body: unknown) {
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as FetchAdapter & ReturnType<typeof vi.fn>;
}

describe('Issue #899: BatchBuilder.submit() continues after a failed operation', () => {
  it('runs every operation in order and only marks the failing one unsuccessful', async () => {
    const client = {
      createStream: vi.fn().mockResolvedValue({ streamId: 'stream-0' }),
      withdraw: vi.fn().mockRejectedValue(new Error('withdraw failed')),
      cancelStream: vi.fn().mockResolvedValue({ txHash: 'tx' }),
    };

    const { results } = await new BatchBuilder(client as unknown as SoroStreamClient)
      .createStream({} as CreateStreamParams)
      .withdraw('stream-1')
      .cancelStream('stream-2')
      .submit();

    expect(results).toEqual([
      { operation: 'createStream', success: true },
      { operation: 'withdraw', success: false, error: 'withdraw failed' },
      { operation: 'cancelStream', success: true },
    ]);
    expect(client.cancelStream).toHaveBeenCalledWith({ streamId: 'stream-2' });
  });
});

describe('Issue #901: createSimplePriceFeed caches per (token, currency) pair', () => {
  it('fetches separately per currency and reuses the cached usd entry', async () => {
    const fetchMock = mockFetch({ [TOKEN]: { usd: 1.5, eur: 1.4 } });
    const feed = createSimplePriceFeed({ apiUrl: API_URL, fetch: fetchMock });

    expect(await feed.getPrice(TOKEN, 'usd')).toBe(1.5);
    expect(await feed.getPrice(TOKEN, 'eur')).toBe(1.4);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(await feed.getPrice(TOKEN, 'usd')).toBe(1.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Issue #902: createSimplePriceFeed defaults to 0 for missing data', () => {
  it('returns 0 instead of throwing when the token is missing', async () => {
    const feed = createSimplePriceFeed({ apiUrl: API_URL, fetch: mockFetch({}) });
    await expect(feed.getPrice(TOKEN, 'usd')).resolves.toBe(0);
  });

  it('returns 0 instead of throwing when the currency is missing', async () => {
    const feed = createSimplePriceFeed({
      apiUrl: API_URL,
      fetch: mockFetch({ [TOKEN]: { eur: 1.4 } }),
    });
    await expect(feed.getPrice(TOKEN, 'usd')).resolves.toBe(0);
  });
});

describe('Issue #903: createSimplePriceFeed uses custom fetch and headers', () => {
  it('invokes the custom adapter with the expected URL and exact headers object', async () => {
    const headers = { 'x-api-key': 'secret', Accept: 'application/json' };
    const fetchMock = mockFetch({ [TOKEN]: { usd: 2 } });
    const feed = createSimplePriceFeed({ apiUrl: API_URL, headers, fetch: fetchMock });

    expect(await feed.getPrice(TOKEN, 'usd')).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/${TOKEN}?vs_currencies=usd`, { headers });
    expect(fetchMock.mock.calls[0][1].headers).toBe(headers);
  });
});
