import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==========================================
// --- 1. CORE IMPLEMENTATION CODE ---
// ==========================================

export class SoroStreamSDKConcurreny {
  private currentSequence = 1000;
  // A promise-chain lock to act as a serialization queue
  private submissionQueue: Promise<any> = Promise.resolve();

  constructor(startingSequence = 1000) {
    this.currentSequence = startingSequence;
  }

  /**
   * Helper to simulate fetching the latest sequence number from the network.
   * If not serialized, two concurrent reads will return the same number.
   */
  private async getLatestSequence(): Promise<number> {
    // Small artificial delay to simulate real network round-trip latency
    await new Promise((resolve) => setTimeout(resolve, 10));
    return this.currentSequence;
  }

  /**
   * Core workflow function to execute batch withdrawals safely
   */
  async batchWithdraw(streamIds: string[]): Promise<{ txId: string; seqUsed: number }> {
    // EXPECTED BEHAVIOR: Serialize concurrent submissions by queuing up promises sequentially
    return new Promise((resolve, reject) => {
      this.submissionQueue = this.submissionQueue.then(async () => {
        try {
          const seq = await this.getLatestSequence();

          // Simulate building and submitting transaction...
          const txId = `tx_${Math.random().toString(36).substring(2, 9)}`;
          const result = { txId, seqUsed: seq };

          // Increment sequence locally upon successful simulated submission
          this.currentSequence++;

          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Exposes raw sequence for assertions
   */
  getSequenceCounter(): number {
    return this.currentSequence;
  }
}

// ==========================================
// --- 2. TDD AUTOMATED TEST SUITE ---
// ==========================================

describe('TDD - Batch Withdraw Concurrency & Sequence Serialization Engine', () => {
  let sdk: SoroStreamSDKConcurreny;

  beforeEach(() => {
    sdk = new SoroStreamSDKConcurreny(5000); // Start at sequence 5000
  });

  it('should successfully serialize concurrent batchWithdraw calls and increment sequence numbers uniquely', async () => {
    const batch1 = ['stream_01', 'stream_02'];
    const batch2 = ['stream_03', 'stream_04'];

    // Act: Fire both calls simultaneously WITHOUT awaiting the first one
    const [res1, res2] = await Promise.all([sdk.batchWithdraw(batch1), sdk.batchWithdraw(batch2)]);

    // Assert: Check that sequence number conflicts were completely bypassed
    expect(res1.seqUsed).toBe(5000);
    expect(res2.seqUsed).toBe(5001); // The second call was delayed until the first finished and incremented

    // Confirm final state counter is sitting at 5002
    expect(sdk.getSequenceCounter()).toBe(5002);
  });
});
