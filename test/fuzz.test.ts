/**
 * Fuzz tests for validateStreamParams / CreateStreamParams (Issue #106).
 * Asserts that no combination of inputs causes an unhandled TypeError or RangeError.
 * Uses fast-check with 50,000 iterations in CI.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const NUM_RUNS = 50_000;

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

// Arbitrary that generates any string (including empty, unicode, huge strings)
const anyStringArb = fc.oneof(
  fc.string(),
  fc.string({ minLength: 0, maxLength: 200 }),
  fc.constantFrom('', '0', 'G', 'C', 'invalid', 'GAAAA', ' '),
  // Valid-looking Stellar addresses to exercise the address path
  fc.constantFrom(VALID_ACCOUNT, VALID_CONTRACT),
);

// Arbitrary for amount: mix of zero, negative, positive, and huge values
const amountArb = fc.oneof(
  fc.bigInt({ min: -1_000_000n, max: 1_000_000_000_000n }),
  fc.constantFrom(0n, -1n, 1n, BigInt(Number.MAX_SAFE_INTEGER)),
);

// Arbitrary for durationSeconds: zero, negative, positive, huge
const durationArb = fc.oneof(
  fc.integer({ min: -1000, max: 1_000_000_000 }),
  fc.constantFrom(0, -1, 1, Number.MAX_SAFE_INTEGER, NaN, Infinity),
);

describe('fuzz: validateStreamParams never throws TypeError or RangeError', () => {
  it('handles any CreateStreamParams input gracefully', () => {
    const mockAdapter: WalletAdapter = {
      getPublicKey: async () => VALID_ACCOUNT,
      signTransaction: async (xdr: string) => xdr,
      isConnected: async () => true,
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    // Patch the server so network calls never trigger
    (client as any).server = {
      getAccount: async () => {
        throw new Error('not found');
      },
      simulateTransaction: async () => {
        throw new Error('no rpc');
      },
      prepareTransaction: async () => {
        throw new Error('no rpc');
      },
      sendTransaction: async () => {
        throw new Error('no rpc');
      },
      getTransaction: async () => {
        throw new Error('no rpc');
      },
    };

    fc.assert(
      fc.asyncProperty(
        anyStringArb,
        anyStringArb,
        amountArb,
        durationArb,
        fc.boolean(),
        async (recipient, token, amount, durationSeconds, autoRenew) => {
          try {
            await client.createStream({ recipient, token, amount, durationSeconds, autoRenew });
          } catch (err) {
            // TypeError and RangeError are never acceptable
            if (err instanceof TypeError) throw err;
            if (err instanceof RangeError) throw err;
            // All other errors (SoroStreamError, generic Error) are acceptable
          }
          // Always return true — the property holds as long as no TypeError/RangeError escapes
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
