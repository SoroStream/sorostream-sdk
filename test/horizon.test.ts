import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';

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

      const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(requestedUrls).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^https:\/\/regional\.example\/horizon\/accounts\//),
        ]),
      );
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
});
