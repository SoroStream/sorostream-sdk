/**
 * Tests for issue #453: the WalletConnect adapter must detect an expired (or
 * deleted) session between signing operations and prompt the user to
 * reconnect instead of silently attempting to sign with the stale session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletConnectSessionExpiredError } from '../src/errors.js';
import type { WalletAdapter } from '../src/types.js';

const TEST_ACCOUNT = 'stellar:testnet:GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const TEST_PUBLIC_KEY = TEST_ACCOUNT.split(':')[2]!;

type Namespaces = Record<string, { accounts: string[]; methods: string[]; events: string[] }>;
type ConnectResult = { topic: string; namespaces: Namespaces };
type SessionRecord = { topic: string; expiry: number };

interface MockSignClient {
  connect: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  sessions: Map<string, SessionRecord>;
  signClient: {
    connect(params: unknown): Promise<ConnectResult>;
    request(params: unknown): Promise<unknown>;
    disconnect(params: unknown): Promise<void>;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
    session: {
      get(topic: string): SessionRecord;
      getAll(): SessionRecord[];
    };
  };
}

function makeSignClient(): MockSignClient {
  const sessions = new Map<string, SessionRecord>();
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const connect = vi.fn();
  const request = vi.fn();
  const disconnect = vi.fn();

  connect.mockImplementation(async () => {
    const topic = `topic-${connect.mock.calls.length}`;
    sessions.set(topic, { topic, expiry: Math.floor(Date.now() / 1000) + 3600 });
    return {
      topic,
      namespaces: {
        stellar: { accounts: [TEST_ACCOUNT], methods: ['stellar_signXDR'], events: [] },
      },
    };
  });
  request.mockResolvedValue({ signedXdr: 'signed_xdr_1' });
  disconnect.mockResolvedValue(undefined);

  return {
    connect,
    request,
    disconnect,
    handlers,
    sessions,
    signClient: {
      connect,
      request,
      disconnect,
      on: (event, cb) => {
        (handlers[event] ??= []).push(cb);
      },
      off: vi.fn(),
      session: {
        get: (topic: string) => {
          const session = sessions.get(topic);
          if (!session) {
            throw new Error(`No matching key with session topic: ${topic}`);
          }
          return session;
        },
        getAll: () => Array.from(sessions.values()),
      },
    },
  };
}

function mockWalletConnectModule(m: MockSignClient): void {
  vi.doMock('@walletconnect/sign-client', () => ({
    default: { init: vi.fn().mockResolvedValue(m.signClient) },
  }));
}

type ConnectableAdapter = WalletAdapter & { disconnect(): Promise<void> };

async function createAdapter(projectId = 'test-project'): Promise<ConnectableAdapter> {
  const { createWalletConnectV2Adapter } = await import('../src/wallet.js');
  return (await createWalletConnectV2Adapter({ projectId })) as ConnectableAdapter;
}

afterEach(() => {
  vi.doUnmock('@walletconnect/sign-client');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createWalletConnectV2Adapter (issue #453 session expiry)', () => {
  it('throws a helpful error when @walletconnect/sign-client is not installed', async () => {
    vi.doMock('@walletconnect/sign-client', () => {
      throw new Error("Cannot find module '@walletconnect/sign-client'");
    });

    await expect(createAdapter()).rejects.toThrow('WalletConnect Sign Client is not installed');
  });

  it('connects via signClient.connect and exposes the Stellar public key', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();

    expect(await adapter.isConnected()).toBe(false);
    expect(await adapter.getPublicKey()).toBe(TEST_PUBLIC_KEY);
    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(await adapter.isConnected()).toBe(true);
  });

  it('detects session expiry via the session_expire event and notifies subscribers', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();
    expect(await adapter.isConnected()).toBe(true);

    const events: boolean[] = [];
    adapter.onConnectionChange!((connected) => events.push(connected));

    // The wallet emits session_expire between signing operations.
    m.handlers['session_expire']?.forEach((handler) => handler({ topic: 'topic-1' }));

    expect(await adapter.isConnected()).toBe(false);
    expect(events).toEqual([false]);

    // The next sign re-runs connect() — prompting the user to reconnect —
    // instead of signing with the stale session.
    const signed = await adapter.signTransaction('xdr-payload', 'testnet');
    expect(m.connect).toHaveBeenCalledTimes(2);
    expect(signed).toBe('signed_xdr_1');
    expect(await adapter.isConnected()).toBe(true);
  });

  it('treats a wallet-side session_delete as a disconnect', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();

    const events: boolean[] = [];
    adapter.onConnectionChange!((connected) => events.push(connected));

    m.handlers['session_delete']?.forEach((handler) => handler({ id: 1, topic: 'topic-1' }));

    expect(await adapter.isConnected()).toBe(false);
    expect(events).toEqual([false]);
  });

  it('detects an expired session by its expiry timestamp between sign operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));

    const m = makeSignClient();
    m.connect.mockImplementation(async () => {
      const topic = 'topic-expiring';
      m.sessions.set(topic, { topic, expiry: Math.floor(Date.now() / 1000) + 3600 });
      return {
        topic,
        namespaces: {
          stellar: { accounts: [TEST_ACCOUNT], methods: ['stellar_signXDR'], events: [] },
        },
      };
    });
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();
    expect(await adapter.isConnected()).toBe(true);

    // Two hours pass with no wallet events — the session is now past expiry.
    vi.setSystemTime(new Date('2026-08-01T02:00:00Z'));

    expect(await adapter.isConnected()).toBe(false);

    // Signing must not use the stale session: it re-connects instead.
    await adapter.signTransaction('xdr-payload', 'testnet');
    expect(m.connect).toHaveBeenCalledTimes(2);
  });

  it('reports disconnected when the session leaves the sign client registry', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();
    expect(await adapter.isConnected()).toBe(true);

    // The relay drops the session without delivering an event.
    m.sessions.clear();

    expect(await adapter.isConnected()).toBe(false);

    const signed = await adapter.signTransaction('xdr-payload', 'testnet');
    expect(m.connect).toHaveBeenCalledTimes(2);
    expect(signed).toBe('signed_xdr_1');
  });

  it('normalises a stale-topic request error into WalletConnectSessionExpiredError', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();

    const events: boolean[] = [];
    adapter.onConnectionChange!((connected) => events.push(connected));

    // The relay rejects the request because the session topic is gone.
    m.request.mockRejectedValue(new Error('No matching key with session topic: topic-1'));

    await expect(adapter.signTransaction('xdr-payload', 'testnet')).rejects.toThrow(
      WalletConnectSessionExpiredError,
    );
    expect(events).toEqual([false]);
    expect(await adapter.isConnected()).toBe(false);

    // The next sign reconnects and succeeds.
    m.request.mockResolvedValue({ signedXdr: 'signed_2' });
    const signed = await adapter.signTransaction('xdr-payload', 'testnet');
    expect(m.connect).toHaveBeenCalledTimes(2);
    expect(signed).toBe('signed_2');
  });

  it('rethrows non-session errors from request unchanged', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();

    // A user rejection is not a session-expiry failure and must surface as-is.
    m.request.mockRejectedValue(new Error('User rejected the signing request'));

    await expect(adapter.signTransaction('xdr-payload', 'testnet')).rejects.toThrow(
      'User rejected the signing request',
    );
    expect(await adapter.isConnected()).toBe(true);
  });

  it('disconnect() releases the session and reports disconnected', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    await adapter.getPublicKey();

    await adapter.disconnect();

    expect(m.disconnect).toHaveBeenCalledWith({
      topic: 'topic-1',
      reason: expect.objectContaining({ code: 6000 }),
    });
    expect(await adapter.isConnected()).toBe(false);
  });

  it('isConnected() is false before any session is established', async () => {
    const m = makeSignClient();
    mockWalletConnectModule(m);

    const adapter = await createAdapter();
    expect(await adapter.isConnected()).toBe(false);
  });
});
