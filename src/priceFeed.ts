import type { PriceFeedAdapter } from './types.js';
import type { FetchAdapter } from './adapters.js';

export interface SimplePriceFeedOptions {
  /** Base URL for the price API (e.g. "https://api.coingecko.com/api/v3/simple/price"). */
  apiUrl: string;
  /** Optional request headers. */
  headers?: Record<string, string>;
  /** Cache duration in ms (default: 60000). */
  cacheMs?: number;
  /** Overrides the global `fetch` used to query the price API (issue #199). */
  fetch?: FetchAdapter;
}

interface CacheEntry {
  price: number;
  expiresAt: number;
}

export function createSimplePriceFeed(options: SimplePriceFeedOptions): PriceFeedAdapter {
  const cache = new Map<string, CacheEntry>();
  const cacheMs = options.cacheMs ?? 60_000;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async getPrice(tokenAddress: string, displayCurrency = 'usd'): Promise<number> {
      const key = `${tokenAddress}:${displayCurrency}`;
      const cached = cache.get(key);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.price;
      }

      const url = `${options.apiUrl}/${tokenAddress}?vs_currencies=${displayCurrency}`;
      const response = await fetchImpl(url, { headers: options.headers });
      if (!response.ok) {
        throw new Error(`Price feed request failed: ${response.status}`);
      }
      const data = (await response.json()) as Record<string, Record<string, number>>;
      const tokenData = data[tokenAddress];
      const price = tokenData?.[displayCurrency] ?? 0;

      cache.set(key, { price, expiresAt: Date.now() + cacheMs });
      return price;
    },
  };
}
