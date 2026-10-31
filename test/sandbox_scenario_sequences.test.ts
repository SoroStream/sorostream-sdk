/**
 * Tests for Issue #696: Sandbox scenario registry sequence support.
 *
 * Verifies that a scenario registered as an array of handlers is consumed one
 * entry per call, and that exhausting the sequence falls back to
 * `defaultBehavior`.
 */
import { describe, it, expect } from 'vitest';
import { SoroStreamSandbox, SandboxUnexpectedCallError } from '../src/sandbox.js';

const STREAM_ID = 'stream-001';
const FAKE_PARAMS = {
  recipient: 'GADDR',
  token: 'USDC',
  amount: 100_000_000n,
  durationSeconds: 3600,
  autoRenew: false,
};

describe('SoroStreamSandbox sequence scenarios (issue #696)', () => {
  it('single-function scenario still works as before', async () => {
    const sandbox = new SoroStreamSandbox({
      getClaimable: async () => 42n,
    });
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(42n);
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(42n);
  });

  it('array scenario returns handlers in order', async () => {
    const sandbox = new SoroStreamSandbox(
      {
        getClaimable: [async () => 1n, async () => 2n, async () => 3n],
      },
      { defaultBehavior: 'empty' },
    );

    expect(await sandbox.getClaimable(STREAM_ID)).toBe(1n);
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(2n);
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(3n);
  });

  it('falls back to defaultBehavior:"empty" after sequence is exhausted', async () => {
    const sandbox = new SoroStreamSandbox(
      {
        getClaimable: [async () => 99n],
      },
      { defaultBehavior: 'empty' },
    );

    expect(await sandbox.getClaimable(STREAM_ID)).toBe(99n);
    // Sequence exhausted — falls back to empty default (0n)
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(0n);
  });

  it('falls back to defaultBehavior:"error" after sequence is exhausted', async () => {
    const sandbox = new SoroStreamSandbox(
      {
        getClaimable: [async () => 5n],
      },
      { defaultBehavior: 'error' },
    );

    expect(await sandbox.getClaimable(STREAM_ID)).toBe(5n);
    // Sequence exhausted — throws SandboxUnexpectedCallError
    await expect(sandbox.getClaimable(STREAM_ID)).rejects.toBeInstanceOf(
      SandboxUnexpectedCallError,
    );
  });

  it('2-fail-then-succeed scenario for getClaimable', async () => {
    const flakyError = new Error('RPC timeout');
    const sandbox = new SoroStreamSandbox(
      {
        getClaimable: [
          async () => {
            throw flakyError;
          },
          async () => {
            throw flakyError;
          },
          async () => 1_000_000n,
        ],
      },
      { defaultBehavior: 'error' },
    );

    await expect(sandbox.getClaimable(STREAM_ID)).rejects.toBe(flakyError);
    await expect(sandbox.getClaimable(STREAM_ID)).rejects.toBe(flakyError);
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(1_000_000n);
  });

  it('2-fail-then-succeed scenario for createStream', async () => {
    const netErr = new Error('network error');
    const sandbox = new SoroStreamSandbox(
      {
        createStream: [
          async () => {
            throw netErr;
          },
          async () => {
            throw netErr;
          },
          async () => ({ streamId: 'stream-42', txHash: '0xabc' }),
        ],
      },
      { defaultBehavior: 'error' },
    );

    await expect(sandbox.createStream(FAKE_PARAMS)).rejects.toBe(netErr);
    await expect(sandbox.createStream(FAKE_PARAMS)).rejects.toBe(netErr);
    const result = await sandbox.createStream(FAKE_PARAMS);
    expect(result.streamId).toBe('stream-42');
  });

  it('independent sequences per method do not interfere', async () => {
    const sandbox = new SoroStreamSandbox(
      {
        getClaimable: [async () => 1n, async () => 2n],
        estimateFee: [async () => 100n, async () => 200n],
      },
      { defaultBehavior: 'empty' },
    );

    expect(await sandbox.getClaimable(STREAM_ID)).toBe(1n);
    expect(await sandbox.estimateFee({})).toBe(100n);
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(2n);
    expect(await sandbox.estimateFee({})).toBe(200n);
  });
});
