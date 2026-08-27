import { describe, it, expect, vi } from 'vitest';
import {
  SoroStreamClient,
  SoroStreamSandbox,
  watchClaimable,
  InMemoryEventBus,
} from '../src/index.js';
import type {
  Network,
  Stream,
  WalletAdapter,
  WalletAdapterSignResult,
  CacheInvalidatedEventPayload,
} from '../src/index.js';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(SENDER),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '1',
    sender: SENDER,
    recipient: RECIPIENT,
    token: 'GTOKEN',
    deposit: 1_000_000n,
    flowRate: 1_000n,
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

function makeStreamsResult(streams: Stream[]): rpc.Api.SimulateTransactionSuccessResponse {
  const scVal = nativeToScVal(
    streams.map((s) => ({
      id: s.id,
      sender: s.sender,
      recipient: s.recipient,
      token: s.token,
      deposit: Number(s.deposit),
      flow_rate: Number(s.flowRate),
      start_time: s.startTime,
      end_time: s.endTime,
      last_withdraw_time: s.lastWithdrawTime,
      status: s.status,
      auto_renew: s.autoRenew,
    })),
  );
  return {
    result: { retval: scVal },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

describe('Issue #342: Network switch cache invalidation and event emission', () => {
  it('emits cacheInvalidated event and clears cache on setNetwork', async () => {
    const eventBus = new InMemoryEventBus();
    const emittedEvents: CacheInvalidatedEventPayload[] = [];
    eventBus.on('cacheInvalidated', (data) => {
      emittedEvents.push(data as CacheInvalidatedEventPayload);
    });

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      eventBus,
    });

    vi.spyOn((client as any).contract, 'call').mockImplementation(() => ({
      build: () => ({}),
    }));
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue(makeStreamsResult([makeStream()]));

    await client.getStreamsByRecipient(RECIPIENT);
    expect((client as any).recipientCache.size).toBeGreaterThan(0);

    // Switch network
    client.setNetwork('mainnet');

    // Cache should be flushed
    expect((client as any).recipientCache.size).toBe(0);

    // Should have emitted cacheInvalidated event
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toMatchObject({
      reason: 'networkSwitch',
      network: 'mainnet',
      previousNetwork: 'testnet',
    });
  });
});

describe('Issue #343: Explain mode does not mutate local cache or stream status', () => {
  it('leaves stream Active after dry-run cancelStream with explain: true', async () => {
    const sandbox = new SoroStreamSandbox();
    const { streamId } = await sandbox.createStream({
      recipient: RECIPIENT,
      token: 'GUSDC',
      amount: 1_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const initial = await sandbox.getStream(streamId);
    expect(initial.status).toBe('Active');

    // Dry run cancelStream
    const explanation = await sandbox.cancelStream({ streamId }, undefined, { explain: true });
    expect(explanation).toBeDefined();

    // Stream should still be Active
    const afterExplain = await sandbox.getStream(streamId);
    expect(afterExplain.status).toBe('Active');

    // Real cancel
    await sandbox.cancelStream({ streamId });
    const afterRealCancel = await sandbox.getStream(streamId);
    expect(afterRealCancel.status).toBe('Cancelled');
  });
});

describe('Issue #344: Public exports for WalletAdapter and WalletAdapterSignResult', () => {
  it('allows WalletAdapter and WalletAdapterSignResult to be used as types', () => {
    const res: WalletAdapterSignResult = {
      signedXdr: 'AAAA...',
      txHash: 'hash...',
    };
    expect(res.signedXdr).toBe('AAAA...');

    const adapter: WalletAdapter = makeAdapter();
    expect(adapter.getPublicKey).toBeDefined();
  });
});

describe('Issue #348: SoroStreamSandbox offline test environment', () => {
  it('runs createStream -> watchClaimable -> withdraw flow offline', async () => {
    const sandbox = new SoroStreamSandbox(SENDER);

    // 1. Create stream
    const { streamId } = await sandbox.createStream({
      recipient: RECIPIENT,
      token: 'GUSDC',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    expect(streamId).toBeDefined();
    const stream = await sandbox.getStream(streamId);
    expect(stream.status).toBe('Active');

    // 2. Watch claimable
    const onTick = vi.fn();
    const unsubscribe = watchClaimable(stream, () => sandbox.getClaimable(stream.id), onTick, {
      tickMs: 100,
    });

    sandbox.advanceTime(stream.id, 360);
    const claimable = await sandbox.getClaimable(stream.id);
    expect(claimable).toBeGreaterThan(0n);

    // 3. Withdraw
    const withdrawRes = await sandbox.withdraw({ streamId });
    expect(withdrawRes.txHash).toBeDefined();
    expect(BigInt(withdrawRes.amount)).toBeGreaterThan(0n);

    unsubscribe();

    // 4. Assertions
    sandbox.assertCalled('createStream');
    sandbox.assertCalled('withdraw');
    sandbox.assertCalledWith('createStream', ([params]) => {
      return (params as any).recipient === RECIPIENT;
    });
  });

  it('handles scenario configuration and unexpected call policies', async () => {
    const sandbox = new SoroStreamSandbox(SENDER);

    sandbox.configureScenario('customOp', () => 'mocked-result');
    expect(await (sandbox as any).customOp()).toBe('mocked-result');

    sandbox.setUnexpectedCallPolicy('error');
    expect(() => (sandbox as any).unconfiguredOp()).toThrow(
      'Unexpected call to unconfigured sandbox operation: "unconfiguredOp"',
    );
  });
});
