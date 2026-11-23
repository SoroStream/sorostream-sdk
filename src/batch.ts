/**
 * Batch/bulk operation helpers — separate entry point for integrators that
 * only need CSV parsing, batch sizing, and bulk-operation types without
 * pulling in the full default entry point's surface area.
 *
 * `SoroStreamClient`'s `bulkCreateStreams`, `batchWithdraw`, `batchCancel`,
 * and `executeBatch` methods are part of the client itself (see
 * `@sorostream/sdk` or `@sorostream/sdk/core`) — this entry point covers the
 * standalone helpers and result/option types around them.
 *
 * ### Why `ConnectionPool` is also exported here
 *
 * It is not a batching helper. No bulk or batch operation depends on it: the
 * pool manages RPC connections and event pollers for event-stream
 * subscriptions (see `useConnectionPooling` / `poolSize` on the client). It has
 * been re-exported from this entry point since the sub-path entry points were
 * introduced (#206), and is kept so that existing
 * `import { ConnectionPool } from '@sorostream/sdk/batch'` code keeps working.
 * New code should import it from `@sorostream/sdk/core` (or the package root);
 * the same class is exported from all three.
 *
 * @example
 * ```ts
 * import { parseCsvStreamRows, batchSize } from "@sorostream/sdk/batch";
 * ```
 */

export { BatchBuilder, SOROBAN_MAX_OPS_PER_TX } from './batchBuilder.js';

export { parseCsvStreamRows, batchSize } from './utils.js';
export { ConnectionPool } from './connectionPool.js';
export type { ConnectionPoolOptions, PoolEvent, PoolEventType } from './connectionPool.js';
export type {
  BulkStreamRow,
  BulkCreateOptions,
  BulkCreateBatchResult,
  BulkCreateResult,
  BatchCancelResult,
  BatchWithdrawResult,
  BatchWithdrawPartialResult,
  BatchProgress,
} from './types.js';
export { BulkCreatePartialError } from './errors.js';
export type { BulkCreateFailedSlot } from './errors.js';
