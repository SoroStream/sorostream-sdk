import { describe, it, expect, vi } from 'vitest';
import { cmdList } from '../packages/cli/src/commands.js';
import type { RpcTransportAdapter } from '../src/transport.js';
import { Keypair, Account, nativeToScVal } from '@stellar/stellar-sdk';

describe('Issue #424: CLI tool list command', () => {
  const secret = Keypair.random().secret();
  const senderKey = Keypair.random().publicKey();
  const recipientKey = Keypair.random().publicKey();

  const mockTransport: RpcTransportAdapter = {
    getAccount: vi.fn().mockImplementation(async (addr: string) => new Account(addr, '1')),
    getHealth: vi.fn(),
    getLatestLedger: vi.fn(),
    getTransaction: vi.fn(),
    simulateTransaction: vi.fn().mockResolvedValue({
      result: {
        retval: nativeToScVal([
          {
            id: '1',
            sender: senderKey,
            recipient: recipientKey,
            token: 'GTOKEN',
            deposit: 1000n,
            flow_rate: 10n,
            start_time: 1000,
            end_time: 2000,
            auto_renew: false,
          },
        ]),
      },
    }),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getEvents: vi.fn(),
  };

  it('lists streams by sender', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdList({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      rpc: [],
      secret,
      transport: mockTransport,
      sender: senderKey,
      status: 'active',
      limit: 10,
    });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('"id": "1"');

    consoleSpy.mockRestore();
  });

  it('lists streams by recipient', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdList({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      rpc: [],
      secret,
      transport: mockTransport,
      recipient: recipientKey,
      limit: 5,
    });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('"id": "1"');

    consoleSpy.mockRestore();
  });
});
