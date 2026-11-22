/**
 * Issue #761: `src/sandbox.ts` (a scenario-based mocking sandbox, Issue #332)
 * was not re-exported from `src/index.ts` and had no subpath entry in
 * `package.json`'s `exports` map, so it was unreachable by any package
 * consumer — even though the closely related `./mock` and `./testing`
 * subpaths already shipped.
 *
 * This test imports the module via its newly-added public entry point
 * (`@sorostream/sdk/sandbox`) to confirm the surface is wired up, and that
 * the existing scenario-registration behavior is unchanged.
 */
import { describe, it, expect } from 'vitest';

// Import via the public subpath entry point — NOT the deep `../src/sandbox.js`
// path. If the `./sandbox` subpath export (or the vitest alias that stands in
// for it) is missing, this import fails to resolve.
import { SoroStreamSandbox, SandboxUnexpectedCallError } from '@sorostream/sdk/sandbox';
import type { ScenarioMap, SandboxOptions } from '@sorostream/sdk/sandbox';

const STREAM_ID = 'stream-public-001';
const FAKE_PARAMS = {
  recipient: 'GADDR',
  token: 'USDC',
  amount: 100_000_000n,
  durationSeconds: 3600,
  autoRenew: false,
};

describe('Issue #761: sandbox module reachable via @sorostream/sdk/sandbox', () => {
  it('exports the scenario-based SoroStreamSandbox class and error type', () => {
    expect(typeof SoroStreamSandbox).toBe('function');
    expect(SandboxUnexpectedCallError).toBeInstanceOf(Function);
  });

  it('ScenarioMap and SandboxOptions types are importable from the subpath', () => {
    // Type-only usage — if the export is missing, TypeScript compilation fails.
    const scenarios: ScenarioMap = {
      getClaimable: async () => 1n,
    };
    const options: SandboxOptions = { defaultBehavior: 'empty', emitEvents: false };
    expect(scenarios.getClaimable).toBeDefined();
    expect(options.defaultBehavior).toBe('empty');
  });

  it('registered scenario behavior is unchanged when used via the public entry point', async () => {
    const sandbox = new SoroStreamSandbox(
      { getClaimable: async () => 42n },
      { defaultBehavior: 'empty' },
    );

    // Registered scenario is dispatched.
    expect(await sandbox.getClaimable(STREAM_ID)).toBe(42n);
    // defaultBehavior: "empty" returns a sensible empty value when no scenario
    // is registered for the method.
    expect(await sandbox.getStreamsBySender('GSENDER')).toEqual([]);
  });

  it('throws SandboxUnexpectedCallError when defaultBehavior is "error" and no scenario is registered', async () => {
    const sandbox = new SoroStreamSandbox({}, { defaultBehavior: 'error' });

    await expect(sandbox.getClaimable(STREAM_ID)).rejects.toBeInstanceOf(
      SandboxUnexpectedCallError,
    );
  });

  it('createStream scenario emits no error and returns the registered result', async () => {
    const sandbox = new SoroStreamSandbox({
      createStream: async () => ({ streamId: 'mock-42', txHash: '0xabc' }),
    });

    const result = await sandbox.createStream(FAKE_PARAMS);
    expect(result).toEqual({ streamId: 'mock-42', txHash: '0xabc' });
  });
});
