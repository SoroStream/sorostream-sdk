import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

describe('client.simulateStream (issue #555)', () => {
  it('returns a fee estimate and isValid: true for valid params', async () => {
    const client = new MockSoroStreamClient();
    const result = await client.simulateStream({
      recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
      token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
      amount: 1_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    expect(result.isValid).toBe(true);
    expect(typeof result.fee).toBe('number');
    expect(result.fee).toBeGreaterThanOrEqual(0);
    expect(result.footprint).toBeDefined();
    expect(Array.isArray(result.footprint.readOnly)).toBe(true);
    expect(Array.isArray(result.footprint.readWrite)).toBe(true);
  });

  it('returns isValid: false for invalid params (zero amount)', async () => {
    const client = new MockSoroStreamClient();
    const result = await client.simulateStream({
      recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
      token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
      amount: 0n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    expect(result.isValid).toBe(false);
    expect(result.fee).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns isValid: false for invalid params (zero duration)', async () => {
    const client = new MockSoroStreamClient();
    const result = await client.simulateStream({
      recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
      token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
      amount: 1_000_000n,
      durationSeconds: 0,
      autoRenew: false,
    });

    expect(result.isValid).toBe(false);
    expect(result.fee).toBe(0);
    expect(result.error).toBeDefined();
  });
});
