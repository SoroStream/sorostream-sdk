/**
 * Tests for issue #900: BatchBuilder.operationCount reflects the queue size
 * before submit() and remains unchanged after submit() completes.
 *
 * BatchBuilder.operationCount is a getter over this.ops.length, and submit()
 * never clears this.ops after running.  A BatchBuilder instance is therefore
 * not reusable/resettable after submit — operationCount documents that
 * invariant directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { BatchBuilder } from '../src/batchBuilder.js';
import type { SoroStreamClient } from '../src/SoroStreamClient.js';

function makeBatchClient() {
  return {
    createStream: vi.fn().mockResolvedValue({ streamId: 'stream-0' }),
    cancelStream: vi.fn().mockResolvedValue({ txHash: 'tx' }),
    withdraw: vi.fn().mockResolvedValue({ txHash: 'tx' }),
  };
}

describe('BatchBuilder.operationCount (#900)', () => {
  it('reflects the queue size before submit()', () => {
    const client = makeBatchClient();
    const builder = new BatchBuilder(client as unknown as SoroStreamClient);

    builder.withdraw('stream-1');
    expect(builder.operationCount).toBe(1);

    builder.cancelStream('stream-2');
    expect(builder.operationCount).toBe(2);
  });

  it('remains unchanged after submit() completes — BatchBuilder is not resettable', async () => {
    const client = makeBatchClient();
    const builder = new BatchBuilder(client as unknown as SoroStreamClient);

    builder.withdraw('stream-1');
    builder.cancelStream('stream-2');

    expect(builder.operationCount).toBe(2);

    await builder.submit();

    // submit() runs the ops but does not clear this.ops, so the count is still 2.
    expect(builder.operationCount).toBe(2);
  });

  it('operationCount is still 2 even after a partial failure during submit()', async () => {
    const client = makeBatchClient();
    // Make the second operation fail
    client.cancelStream.mockRejectedValueOnce(new Error('contract error'));

    const builder = new BatchBuilder(client as unknown as SoroStreamClient);
    builder.withdraw('stream-1');
    builder.cancelStream('stream-2');

    expect(builder.operationCount).toBe(2);

    const { results } = await builder.submit();

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);

    // Even after a partial failure, the queue is not modified.
    expect(builder.operationCount).toBe(2);
  });
});
