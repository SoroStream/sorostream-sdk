import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { HORIZON_URLS } from '../src/horizon.js';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const ACCOUNT_ID = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Horizon URL configuration', () => {
  it('uses the configured URL for the client network', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ _embedded: { records: [] } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new SoroStreamClient({
      contractId: CONTRACT_ID,
      network: 'testnet',
      horizonUrls: { testnet: 'https://regional.example/horizon/' },
      skipPeerCheck: true,
      telemetry: false,
    });

    try {
      await client.getAddressActivity(ACCOUNT_ID);

      // The client also pings the RPC health endpoint on construction
      // (unrelated to Horizon), so only inspect the Horizon-bound requests.
      const requestedUrls = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes('/accounts/'));
      expect(requestedUrls).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^https:\/\/regional\.example\/horizon\/accounts\//),
        ]),
      );
      for (const url of requestedUrls) {
        expect(url.startsWith('https://regional.example/horizon/')).toBe(true);
        expect(url.startsWith(HORIZON_URLS.testnet)).toBe(false);
      }
    } finally {
      client.destroy();
    }
  });

  it('rejects malformed Horizon URL overrides', () => {
    expect(
      () =>
        new SoroStreamClient({
          contractId: CONTRACT_ID,
          network: 'testnet',
          horizonUrls: { testnet: 'javascript:alert(1)' },
          skipPeerCheck: true,
          telemetry: false,
        }),
    ).toThrow(/Invalid Horizon URL/);
  });

  it('rejects non-http(s) Horizon URL overrides', () => {
    expect(
      () =>
        new SoroStreamClient({
          contractId: CONTRACT_ID,
          network: 'testnet',
          horizonUrls: { testnet: 'ftp://regional.example/horizon/' },
          skipPeerCheck: true,
          telemetry: false,
        }),
    ).toThrow(/Invalid Horizon URL/);
  });
});
