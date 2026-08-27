import { describe, it, expect } from 'vitest';
import { streamToJSON, jsonStringifyStream, jsonStringify, claimableNow } from '../src/utils.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { MockSoroStreamClient } from '../src/mock.js';
import type { Stream } from '../src/types.js';

describe('JSON Serialization Fixes for BigInt fields', () => {
  it('streamToJSON converts BigInt fields in stream objects to strings', () => {
    const stream: Stream = {
      id: '123',
      sender: 'SENDER',
      recipient: 'RECIPIENT',
      token: 'TOKEN',
      deposit: 1000000000000n,
      flowRate: 500000n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Active',
      autoRenew: false,
    };

    const serialized = streamToJSON(stream) as Record<string, unknown>;
    expect(serialized.deposit).toBe('1000000000000');
    expect(serialized.flowRate).toBe('500000');
    expect(serialized.id).toBe('123');
    expect(serialized.startTime).toBe(1000);
  });

  it('streamToJSON handles nested objects and arrays with BigInts (e.g. totalAmount, claimableAmount)', () => {
    const data = {
      streams: [
        { id: '1', flowRate: 100n, totalAmount: 5000n },
        { id: '2', flowRate: 200n, claimableAmount: 2500n },
      ],
      summary: {
        totalDeposited: 10000n,
        active: true,
      },
    };

    const serialized = streamToJSON(data) as any;
    expect(serialized.streams[0].flowRate).toBe('100');
    expect(serialized.streams[0].totalAmount).toBe('5000');
    expect(serialized.streams[1].claimableAmount).toBe('2500');
    expect(serialized.summary.totalDeposited).toBe('10000');
  });

  it('jsonStringifyStream / jsonStringify successfully serializes objects without throwing TypeError', () => {
    const obj = {
      flowRate: 123456n,
      totalAmount: 987654321n,
      claimableAmount: 55555n,
    };

    const jsonStr = jsonStringify(obj);
    expect(jsonStr).toContain('"flowRate":"123456"');
    expect(jsonStr).toContain('"totalAmount":"987654321"');
    expect(jsonStr).toContain('"claimableAmount":"55555"');

    const parsed = JSON.parse(jsonStr);
    expect(parsed.flowRate).toBe('123456');
    expect(parsed.totalAmount).toBe('987654321');
    expect(parsed.claimableAmount).toBe('55555');
  });

  it('MockSoroStreamClient createStream returns streams with a working toJSON method', async () => {
    const mock = new MockSoroStreamClient();
    const { streamId } = await mock.createStream({
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const stream = await mock.getStream(streamId);
    expect(stream.toJSON).toBeDefined();

    // JSON.stringify should automatically invoke toJSON() without throwing TypeError
    const jsonStr = JSON.stringify(stream);
    expect(jsonStr).toContain('"deposit":"1000000000"');
    expect(jsonStr).toContain('"flowRate":"277777"');

    const parsed = JSON.parse(jsonStr);
    expect(parsed.deposit).toBe('1000000000');
    expect(parsed.flowRate).toBe('277777');
  });
});
