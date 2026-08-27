import { describe, it, expect, vi } from 'vitest';
import { createRetryingRpcTransport, isTransientRpcError } from '../src/transport.js';
import { SoroStreamClient } from '../src/SoroStreamClient.ts';
import type { RpcTransportAdapter } from '../src/transport.js';

describe('Issue #425: Automatic RPC retry with exponential backoff', () => {
  it('identifies transient RPC errors correctly', () => {
    expect(isTransientRpcError(new Error('NetworkError: fetch failed'))).toBe(true);
    expect(isTransientRpcError({ status: 503 })).toBe(true);
    expect(isTransientRpcError({ status: 429 })).toBe(true);
    expect(isTransientRpcError({ code: -32005 })).toBe(true);
    expect(isTransientRpcError(new Error('Invalid transaction payload'))).toBe(false);
  });

  it('retries transient RPC calls automatically until success', async () => {
    let callCount = 0;
    const mockTransport: RpcTransportAdapter = {
      getAccount: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('ETIMEDOUT: Connection timed out');
        }
        return { sequenceNumber: () => '100' } as any;
      }),
      getHealth: vi.fn(),
      getLatestLedger: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn(),
    };

    const retryingTransport = createRetryingRpcTransport(mockTransport, {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });

    const account = await retryingTransport.getAccount('GAAA');
    expect(callCount).toBe(3);
    expect(account).toBeDefined();
  });

  it('immediately throws non-transient errors without consuming retry budget', async () => {
    let callCount = 0;
    const mockTransport: RpcTransportAdapter = {
      getAccount: vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error('Account not found / invalid parameter');
      }),
      getHealth: vi.fn(),
      getLatestLedger: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn(),
    };

    const retryingTransport = createRetryingRpcTransport(mockTransport, {
      maxAttempts: 5,
      baseDelayMs: 10,
    });

    await expect(retryingTransport.getAccount('GAAA')).rejects.toThrow('Account not found');
    expect(callCount).toBe(1);
  });

  it('integrates rpcRetry options with SoroStreamClient', async () => {
    let callCount = 0;
    const mockTransport: RpcTransportAdapter = {
      getAccount: vi.fn(),
      getHealth: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('503 Service Unavailable');
        }
        return { status: 'healthy' } as any;
      }),
      getLatestLedger: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn(),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      transport: mockTransport,
      rpcRetry: {
        maxAttempts: 3,
        baseDelayMs: 10,
      },
    });

    // Should succeed on second attempt due to rpcRetry wrapping
    const health = await client.healthCheck();
    expect(health.rpcReachable).toBe(true);
    expect(callCount).toBe(2);
  });
});
