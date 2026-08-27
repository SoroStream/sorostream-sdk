/**
 * @sorostream/sdk/testing
 *
 * Official testing utilities for integrators writing unit tests against the
 * SoroStream SDK without hitting a live Soroban network.
 *
 * @example
 * ```ts
 * import { MockSoroStreamClient } from "@sorostream/sdk/testing";
 *
 * const mock = new MockSoroStreamClient();
 * const { streamId } = await mock.createStream({
 *   recipient: "GRECIPIENT...",
 *   token: "GUSDC...",
 *   amount: 1_000_000_000n,
 *   durationSeconds: 3600,
 *   autoRenew: false,
 * });
 * ```
 */
export { MockSoroStreamClient, SoroStreamSandbox } from './mock.js';
export type { SandboxCallLog, SandboxUnexpectedCallPolicy } from './mock.js';
