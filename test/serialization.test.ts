/**
 * Tests for structured clone support (issue #210).
 */

import { describe, it, expect } from 'vitest';
import { serializeStream, deserializeStream } from '../src/serialization.js';
import type { Stream } from '../src/types.js';

describe('Stream serialization (issue #210)', () => {
  it('should serialize and deserialize a stream with all fields', () => {
    const original: Stream = {
      id: '123',
      sender: 'GCTEST',
      recipient: 'GCRECI',
      token: 'GTOKEN',
      deposit: 1_000_000_000n,
      flowRate: 100_000n,
      startTime: 1609459200,
      endTime: 1609545600,
      lastWithdrawTime: 1609459200,
      status: 'Active',
      autoRenew: true,
      pausedAt: 1609500000,
      lockUntil: 1609480000,
    };

    const serialized = serializeStream(original);
    const deserialized = deserializeStream(serialized);

    expect(deserialized).toEqual(original);
  });

  it('should handle BigInt fields without precision loss', () => {
    const stream: Stream = {
      id: '1',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 9_007_199_254_740_991n, // Number.MAX_SAFE_INTEGER
      flowRate: 9_007_199_254_740_991n,
      startTime: 1000000,
      endTime: 2000000,
      lastWithdrawTime: 1000000,
      status: 'Active',
      autoRenew: false,
    };

    const serialized = serializeStream(stream);
    expect(serialized.deposit).toBe('9007199254740991');
    expect(serialized.flowRate).toBe('9007199254740991');

    const deserialized = deserializeStream(serialized);
    expect(deserialized.deposit).toBe(9_007_199_254_740_991n);
    expect(deserialized.flowRate).toBe(9_007_199_254_740_991n);
  });

  it('should handle optional fields correctly', () => {
    const streamWithOptionals: Stream = {
      id: '2',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 1000n,
      flowRate: 10n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Paused',
      autoRenew: true,
      pausedAt: 1500,
      lockUntil: 1200,
    };

    const serialized = serializeStream(streamWithOptionals);
    expect(serialized.pausedAt).toBe(1500);
    expect(serialized.lockUntil).toBe(1200);

    const deserialized = deserializeStream(serialized);
    expect(deserialized.pausedAt).toBe(1500);
    expect(deserialized.lockUntil).toBe(1200);
  });

  it('should omit undefined optional fields', () => {
    const streamWithoutOptionals: Stream = {
      id: '3',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 1000n,
      flowRate: 10n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Completed',
      autoRenew: false,
    };

    const serialized = serializeStream(streamWithoutOptionals);
    expect(serialized.pausedAt).toBeUndefined();
    expect(serialized.lockUntil).toBeUndefined();

    const deserialized = deserializeStream(serialized);
    expect(deserialized.pausedAt).toBeUndefined();
    expect(deserialized.lockUntil).toBeUndefined();
  });

  it('should work with structuredClone', () => {
    const stream: Stream = {
      id: '4',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 5_000_000n,
      flowRate: 1_000n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Active',
      autoRenew: false,
    };

    const serialized = serializeStream(stream);

    // Should not throw
    expect(() => structuredClone(serialized)).not.toThrow();

    const cloned = structuredClone(serialized);
    const deserialized = deserializeStream(cloned);

    expect(deserialized).toEqual(stream);
  });

  it('should handle all stream statuses', () => {
    const statuses: Array<Stream['status']> = ['Active', 'Cancelled', 'Completed', 'Paused'];

    for (const status of statuses) {
      const stream: Stream = {
        id: '5',
        sender: 'GSENDER',
        recipient: 'GRECIPIENT',
        token: 'GTOKEN',
        deposit: 1000n,
        flowRate: 10n,
        startTime: 1000,
        endTime: 2000,
        lastWithdrawTime: 1000,
        status,
        autoRenew: false,
      };

      const serialized = serializeStream(stream);
      const deserialized = deserializeStream(serialized);

      expect(deserialized.status).toBe(status);
    }
  });

  it('should handle very large BigInt values', () => {
    const stream: Stream = {
      id: '6',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 170141183460469231731687303715884105727n, // near i128 max
      flowRate: 1_000_000_000_000n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Active',
      autoRenew: false,
    };

    const serialized = serializeStream(stream);
    const deserialized = deserializeStream(serialized);

    expect(deserialized.deposit).toBe(stream.deposit);
    expect(deserialized.flowRate).toBe(stream.flowRate);
  });

  it('should be deeply equal after round-trip', () => {
    const stream: Stream = {
      id: '7',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 999_888_777n,
      flowRate: 123_456n,
      startTime: 1609459200,
      endTime: 1609545600,
      lastWithdrawTime: 1609470000,
      status: 'Active',
      autoRenew: true,
      lockUntil: 1609480000,
    };

    const roundTrip = deserializeStream(serializeStream(stream));

    // Deep equality check
    expect(JSON.stringify(roundTrip, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(stream, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});
