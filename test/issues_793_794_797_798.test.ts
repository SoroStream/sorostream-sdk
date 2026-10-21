import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginRegistry } from '../src/pluginRegistry.js';
import type { SoroStreamPlugin } from '../src/types.js';
import { setupExpoPolyfills, createFreighterMobileAdapter } from '../packages/react-native/src/index.js';

describe('Issue #798: setupExpoPolyfills idempotency', () => {
  let originalCrypto: unknown;

  beforeEach(() => {
    originalCrypto = (globalThis as any).crypto;
  });

  afterEach(() => {
    (globalThis as any).crypto = originalCrypto;
  });

  it('can be called multiple times without error or double-installation', () => {
    const mockGetRandomValues = vi.fn(<T extends ArrayBufferView | null>(arr: T): T => arr);
    const options = { crypto: { getRandomValues: mockGetRandomValues } };

    // Delete existing crypto if any for clean test
    delete (globalThis as any).crypto;

    // Call 1
    expect(() => setupExpoPolyfills(options)).not.toThrow();
    expect((globalThis as any).crypto).toBeDefined();
    expect((globalThis as any).crypto.getRandomValues).toBe(mockGetRandomValues);

    // Call 2 (idempotent hot-reload or duplicate initialization)
    expect(() => setupExpoPolyfills(options)).not.toThrow();
    expect((globalThis as any).crypto.getRandomValues).toBe(mockGetRandomValues);
  });
});

describe('Issue #797: createFreighterMobileAdapter timeout handling on unresponsive bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when bridge never responds within timeout', async () => {
    // Bridge check promise that never resolves
    const neverEndingBridge = () => new Promise<boolean>(() => {});

    const adapterPromise = createFreighterMobileAdapter({
      timeoutMs: 1000,
      checkBridge: neverEndingBridge,
    });

    vi.advanceTimersByTime(1001);

    await expect(adapterPromise).rejects.toThrow(
      'Freighter mobile bridge failed to respond within 1000ms',
    );
  });

  it('succeeds when bridge responds affirmatively within timeout', async () => {
    const responsiveBridge = vi.fn().mockResolvedValue(true);

    const adapter = await createFreighterMobileAdapter({
      timeoutMs: 1000,
      checkBridge: responsiveBridge,
    });

    expect(adapter).toBeDefined();
    expect(await adapter.isConnected()).toBe(true);
  });
});

describe('Issue #793: PluginRegistry unregister handling while dispatch is in flight', () => {
  it('allows in-flight before-hook dispatch to complete normally even if unregistered mid-execution', async () => {
    const registry = new PluginRegistry();

    let hookStarted = false;
    let hookCompleted = false;

    let resolveHook: () => void;
    const hookPromise = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });

    const plugin: SoroStreamPlugin = {
      name: 'async-plugin',
      before: async () => {
        hookStarted = true;
        await hookPromise;
        hookCompleted = true;
      },
    };

    registry.register(plugin);

    // Start dispatching
    const dispatchPromise = registry.runBefore('createStream', {} as any);

    // Hook has begun executing
    expect(hookStarted).toBe(true);
    expect(hookCompleted).toBe(false);

    // Unregister plugin while hook is still in flight
    const removed = registry.unregister(plugin);
    expect(removed).toBe(true);
    expect(registry.list()).toHaveLength(0);

    // Resolve in-flight hook
    resolveHook!();
    await dispatchPromise;

    // Verify in-flight hook completed without unhandled rejection
    expect(hookCompleted).toBe(true);

    // Subsequent dispatch should NOT invoke the unregistered plugin
    hookStarted = false;
    await registry.runBefore('createStream', {} as any);
    expect(hookStarted).toBe(false);
  });

  it('unregisters cleanly when no dispatch is active', () => {
    const registry = new PluginRegistry();
    const plugin: SoroStreamPlugin = { name: 'noop' };
    registry.register(plugin);
    expect(registry.list()).toHaveLength(1);

    expect(registry.unregister(plugin)).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });
});
