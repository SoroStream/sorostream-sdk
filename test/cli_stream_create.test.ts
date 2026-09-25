import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RpcTransportAdapter } from '../src/transport.js';
import { Keypair, Account, TransactionBuilder } from '@stellar/stellar-sdk';

import { cmdStreamCreate, resolveCreateParams } from '../packages/cli/src/commands.js';
import type { StreamCreateOptions } from '../packages/cli/src/commands.js';

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const SENDER_KP = Keypair.random();
const NETWORK_PASSPHRASE = 'Test SoroStream Network December 2024';

function baseOptions(overrides: Partial<StreamCreateOptions> = {}): StreamCreateOptions {
  return {
    network: 'testnet',
    contractId: CONTRACT,
    rpc: [],
    secret: SENDER_KP.secret(),
    ...overrides,
  };
}

function makeTransport(): RpcTransportAdapter {
  return {
    getAccount: vi.fn().mockImplementation(async (addr: string) => new Account(addr, '1')),
    getHealth: vi.fn(),
    getLatestLedger: vi.fn(),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'tx-abc' }),
    simulateTransaction: vi.fn().mockResolvedValue({
      id: 'sim',
      minResourceFee: '100',
      events: [],
      transactionData: {},
    }),
    prepareTransaction: vi.fn().mockImplementation(async (tx: any) => tx),
    sendTransaction: vi.fn().mockResolvedValue({ hash: 'tx-abc', successful: true }),
    getStreamsBySender: vi.fn().mockImplementation((sender: string) => {
      return [
        {
          id: '1',
          sender,
          recipient: RECIPIENT,
          token: TOKEN,
          deposit: 100_000_000n,
          flowRate: 100n,
          startTime: 1000,
          endTime: 2000,
          autoRenew: false,
        },
      ];
    }),
    getEvents: vi.fn(),
  };
}

vi.mock('node:readline', () => {
  const answers: string[] = [];
  return {
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => {
        const answer = answers.shift() ?? '';
        cb(answer);
      },
      close: () => {},
      on: () => {},
    }),
    __setAnswers: (a: string[]) => {
      answers.length = 0;
      answers.push(...a);
    },
  };
});

describe('stream create — resolveCreateParams', () => {
  it('reads all params from flags when --json is set', async () => {
    const params = await resolveCreateParams(
      baseOptions({
        json: true,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: '100.50',
        duration: 3600,
        autoRenew: true,
      }),
    );

    expect(params).toEqual({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: '100.50',
      duration: 3600,
      autoRenew: true,
    });
  });

  it('throws when --json is set but a required flag is missing', async () => {
    await expect(
      resolveCreateParams(
        baseOptions({
          json: true,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: '100.50',
          // duration intentionally missing
        }),
      ),
    ).rejects.toThrow(/--json requires/);
  });

  it('throws on a non-numeric duration', async () => {
    await expect(
      resolveCreateParams(
        baseOptions({
          json: true,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: '100.50',
          duration: 'not-a-number' as unknown as number,
        }),
      ),
    ).rejects.toThrow(/invalid duration/);
  });
});

describe('stream create — cmdStreamCreate', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('--json submits non-interactively and prints stream id + tx hash', async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, 'sendTransaction')
      .mockResolvedValue({ hash: 'tx-abc', successful: true });

    await cmdStreamCreate(
      baseOptions({
        json: true,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: '100.50',
        duration: 3600,
        autoRenew: false,
        transport,
      }),
    );

    expect(spy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.streamId).toBeTruthy();
    expect(parsed.txHash).toBe('tx-abc');
  });

  it('prompts interactively when --json is absent', async () => {
    const rl = await import('node:readline');
    rl.__setAnswers([RECIPIENT, TOKEN, '50', '7200']);

    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, 'sendTransaction')
      .mockResolvedValue({ hash: 'tx-interactive', successful: true });

    await cmdStreamCreate(
      baseOptions({
        recipient: undefined,
        token: undefined,
        amount: undefined,
        duration: undefined,
        transport,
      }),
    );

    expect(spy).toHaveBeenCalled();
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.streamId).toBeTruthy();
    expect(parsed.txHash).toBe('tx-interactive');
  });
});