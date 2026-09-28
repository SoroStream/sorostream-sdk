/**
 * Type definitions correctness test suite (#642).
 * Verifies compile-time type compatibility and runtime shape conformance
 * to prevent TypeScript types from diverging from implementation.
 */

import { describe, it, expect } from 'vitest';
import type {
  SoroStreamClientConfig,
  CreateStreamParams,
  Stream,
  StreamFilter,
  StreamStatus,
  WalletAdapter,
  WriteOptions,
} from '../src/index.js';
import {
  toStroops,
  formatUSDC,
  claimableNow,
  isExpired,
  calculateVestingSchedule,
} from '../src/index.js';

// Compile-time type assertion utilities
type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;
type Extends<Sub, Super> = Sub extends Super ? true : false;

describe('Type Definitions Correctness (#642)', () => {
  it('verifies StreamStatus union type definition', () => {
    type TestStreamStatus = Expect<
      Equal<StreamStatus, 'Active' | 'Paused' | 'Cancelled' | 'Completed'>
    >;
    const status: StreamStatus = 'Active';
    expect(['Active', 'Paused', 'Cancelled', 'Completed']).toContain(status);
  });

  it('verifies CreateStreamParams interface compatibility', () => {
    const validParams: CreateStreamParams = {
      recipient: 'G...TEST',
      token: 'C...TOKEN',
      amount: 100_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    };

    type CheckRecipient = Expect<Extends<typeof validParams.recipient, string>>;
    type CheckAmount = Expect<Extends<typeof validParams.amount, bigint>>;
    type CheckDuration = Expect<Extends<typeof validParams.durationSeconds, number>>;

    expect(validParams.recipient).toBeTypeOf('string');
    expect(validParams.amount).toBeTypeOf('bigint');
    expect(validParams.durationSeconds).toBeTypeOf('number');
  });

  it('verifies Stream interface shape conformance', () => {
    const sampleStream: Stream = {
      id: 'stream-123',
      sender: 'G...SENDER',
      recipient: 'G...RECIPIENT',
      token: 'C...TOKEN',
      amount: 100_000_000n,
      claimed: 0n,
      startTime: 1700000000,
      stopTime: 1700003600,
      status: 'Active',
      ratePerSecond: 27777n,
    };

    expect(sampleStream.id).toBeTypeOf('string');
    expect(sampleStream.amount).toBeTypeOf('bigint');
    expect(sampleStream.status).toBe('Active');
  });

  it('verifies WalletAdapter interface requirement', () => {
    class DummyAdapter implements WalletAdapter {
      async getPublicKey(): Promise<string> {
        return 'G...DUMMY';
      }
      async signTransaction(xdr: string): Promise<string> {
        return xdr;
      }
    }

    const adapter: WalletAdapter = new DummyAdapter();
    expect(typeof adapter.getPublicKey).toBe('function');
    expect(typeof adapter.signTransaction).toBe('function');
  });

  it('verifies utility function type signatures match runtime outputs', () => {
    const stroops: bigint = toStroops('10.50');
    expect(typeof stroops).toBe('bigint');
    expect(stroops).toBe(105_000_000n);

    const formatted: string = formatUSDC(105_000_000n);
    expect(typeof formatted).toBe('string');
    expect(formatted).toBe('10.5000000');

    const schedule = calculateVestingSchedule(
      {
        id: '1',
        sender: 'G1',
        recipient: 'G2',
        token: 'C1',
        deposit: 100_000_000n,
        flowRate: 27777n,
        startTime: 1000,
        endTime: 4600,
        lastWithdrawTime: 1000,
        status: 'Active',
        autoRenew: false,
      } as any,
      600,
      2000,
    );
    expect(schedule).toBeDefined();
  });
});
