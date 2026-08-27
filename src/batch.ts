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
 * @example
 * ```ts
 * import { parseCsvStreamRows, batchSize } from "@sorostream/sdk/batch";
 * ```
 */

export { BatchBuilder } from './batchBuilder.js';

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
