/**
 * Structured clone support for SDK stream objects across workers (issue #210).
 *
 * Stream objects contain BigInt fields that require custom serialization
 * to work with the structured clone algorithm and Web Workers.
 */

import type { Stream } from './types.js';

/**
 * Serialized representation of a Stream with BigInt fields converted to strings.
 * This format is structured-cloneable and can be passed to Web Workers.
 */
export interface SerializedStream {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  /** deposit as a string to preserve precision */
  deposit: string;
  /** flowRate as a string to preserve precision */
  flowRate: string;
  startTime: number;
  endTime: number;
  lastWithdrawTime: number;
  status: 'Active' | 'Cancelled' | 'Completed' | 'Paused';
  autoRenew: boolean;
  pausedAt?: number;
  lockUntil?: number;
}

/**
 * Converts a Stream object to a structured-cloneable format.
 * BigInt fields are converted to strings to preserve precision.
 *
 * @param stream - The stream object to serialize
 * @returns A SerializedStream that can be passed through structuredClone()
 *
 * @example
 * ```ts
 * const stream = await client.getStream(streamId);
 * const serialized = serializeStream(stream);
 * // Send to worker
 * worker.postMessage({ type: 'PROCESS_STREAM', stream: serialized });
 * ```
 */
export function serializeStream(stream: Stream): SerializedStream {
  return {
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: stream.deposit.toString(),
    flowRate: stream.flowRate.toString(),
    startTime: stream.startTime,
    endTime: stream.endTime,
    lastWithdrawTime: stream.lastWithdrawTime,
    status: stream.status,
    autoRenew: stream.autoRenew,
    ...(stream.pausedAt !== undefined ? { pausedAt: stream.pausedAt } : {}),
    ...(stream.lockUntil !== undefined ? { lockUntil: stream.lockUntil } : {}),
  };
}

/**
 * Converts a SerializedStream back to a Stream object.
 * String BigInt fields are converted back to bigint primitives.
 *
 * @param data - The serialized stream data
 * @returns A Stream object with proper types restored
 *
 * @example
 * ```ts
 * // In worker context
 * self.onmessage = (e) => {
 *   const stream = deserializeStream(e.data.stream);
 *   // Use stream with full bigint support
 *   const claimable = stream.flowRate * BigInt(Date.now() - stream.lastWithdrawTime);
 * };
 * ```
 */
export function deserializeStream(data: SerializedStream): Stream {
  return {
    id: data.id,
    sender: data.sender,
    recipient: data.recipient,
    token: data.token,
    deposit: BigInt(data.deposit),
    flowRate: BigInt(data.flowRate),
    startTime: data.startTime,
    endTime: data.endTime,
    lastWithdrawTime: data.lastWithdrawTime,
    status: data.status,
    autoRenew: data.autoRenew,
    ...(data.pausedAt !== undefined ? { pausedAt: data.pausedAt } : {}),
    ...(data.lockUntil !== undefined ? { lockUntil: data.lockUntil } : {}),
  };
}
