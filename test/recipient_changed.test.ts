import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { Keypair } from '@stellar/stellar-sdk';

describe('#148 onRecipientChanged', () => {
  let mock: MockSoroStreamClient;
  const RECIPIENT_A = Keypair.random().publicKey();
  const RECIPIENT_B = Keypair.random().publicKey();

  beforeEach(() => {
    vi.useFakeTimers();
    mock = new MockSoroStreamClient();
    mock.setSender(Keypair.random().publicKey());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers handler and returns an unsubscribe function', async () => {
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT_A,
      token: 'GTOKEN',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const cb = vi.fn();
    const unsub = mock.onRecipientChanged(streamId, cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('invokes callback with correct payload when recipient changes', async () => {
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT_A,
      token: 'GTOKEN',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const cb = vi.fn();
    mock.onRecipientChanged(streamId, cb, { intervalMs: 1000 });

    // Let the initial poll run (seeds lastRecipient)
    await vi.advanceTimersByTimeAsync(0);

    // Change the recipient
    await mock.transferStream({ streamId, newRecipient: RECIPIENT_B });

    // Trigger next poll
    await vi.advanceTimersByTimeAsync(1000);

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId,
        oldRecipient: RECIPIENT_A,
        newRecipient: RECIPIENT_B,
      }),
    );
  });

  it('does not invoke callback before recipient changes', async () => {
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT_A,
      token: 'GTOKEN',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const cb = vi.fn();
    mock.onRecipientChanged(streamId, cb, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    expect(cb).not.toHaveBeenCalled();
  });

  it('stops polling after unsubscribe', async () => {
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT_A,
      token: 'GTOKEN',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const cb = vi.fn();
    const unsub = mock.onRecipientChanged(streamId, cb, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    unsub();

    await mock.transferStream({ streamId, newRecipient: RECIPIENT_B });
    await vi.advanceTimersByTimeAsync(5000);

    expect(cb).not.toHaveBeenCalled();
  });
});
