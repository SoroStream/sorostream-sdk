import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { MockSoroStreamClient } from '../src/mock.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Stream, WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('Issue #433: getStreamsByTag query method', () => {
  describe('MockSoroStreamClient', () => {
    let mock: MockSoroStreamClient;

    beforeEach(() => {
      mock = new MockSoroStreamClient();
    });

    it('returns streams matching the requested tag', async () => {
      mock.seedStream({
        id: '1',
        sender: 'GSENDER',
        recipient: 'GRECIPIENT',
        token: 'GTOKEN',
        deposit: 1000n,
        flowRate: 10n,
        startTime: 1000,
        endTime: 2000,
        lastWithdrawTime: 1000,
        status: 'Active',
        autoRenew: false,
        tag: 'payroll',
      });

      mock.seedStream({
        id: '2',
        sender: 'GSENDER',
        recipient: 'GRECIPIENT2',
        token: 'GTOKEN',
        deposit: 2000n,
        flowRate: 20n,
        startTime: 1000,
        endTime: 2000,
        lastWithdrawTime: 1000,
        status: 'Active',
        autoRenew: false,
        tag: 'grant',
      });

      const payrollStreams = (await mock.getStreamsByTag('payroll')) as Stream[];
      expect(payrollStreams).toHaveLength(1);
      expect(payrollStreams[0]!.id).toBe('1');
      expect(payrollStreams[0]!.tag).toBe('payroll');

      const grantStreams = (await mock.getStreamsByTag('grant')) as Stream[];
      expect(grantStreams).toHaveLength(1);
      expect(grantStreams[0]!.id).toBe('2');
    });

    it('returns empty array when no streams match tag', async () => {
      const streams = (await mock.getStreamsByTag('nonexistent')) as Stream[];
      expect(streams).toEqual([]);
    });

    it('supports pagination parameters for tag queries', async () => {
      for (let i = 1; i <= 5; i++) {
        mock.seedStream({
          id: String(i),
          sender: 'GSENDER',
          recipient: 'GRECIPIENT',
          token: 'GTOKEN',
          deposit: 1000n,
          flowRate: 10n,
          startTime: 1000,
          endTime: 2000,
          lastWithdrawTime: 1000,
          status: 'Active',
          autoRenew: false,
          tag: 'bounty',
        });
      }

      const page1 = (await mock.getStreamsByTag('bounty', { limit: 2 })) as any;
      expect(page1.streams).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('2');
    });
  });

  describe('SoroStreamClient', () => {
    it('calls get_streams_by_tag on the contract and decodes results', async () => {
      const client = new SoroStreamClient({
        network: 'testnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeAdapter(),
      });

      const mockSimResult = {
        result: {
          retval: nativeToScVal([]),
        },
      };

      vi.spyOn(client as any, 'simulateOp').mockResolvedValue(mockSimResult);

      const streams = await client.getStreamsByTag('project-alpha');
      expect(Array.isArray(streams)).toBe(true);
    });
  });
});
