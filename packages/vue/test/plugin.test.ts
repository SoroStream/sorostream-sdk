/**
 * Tests for issue #801: useSoroStreamClient should throw a clear, actionable
 * error when called outside a component tree where SoroStreamPlugin was never
 * installed, rather than producing a generic "undefined is not an object"
 * failure.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';

import { SoroStreamPlugin, useSoroStreamClient } from '../src/plugin.js';
import type { SoroStreamClient } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal mock client that satisfies the SoroStreamClient type shape enough
// for the plugin — the tests here only care about identity / injection.
// ---------------------------------------------------------------------------
function makeMockClient(): SoroStreamClient {
  return {
    getPublicKey: vi.fn(),
    createStream: vi.fn(),
    withdraw: vi.fn(),
    cancelStream: vi.fn(),
    getStream: vi.fn(),
    getClaimable: vi.fn(),
    getStreamsBySender: vi.fn(),
    getStreamsByRecipient: vi.fn(),
  } as unknown as SoroStreamClient;
}

// ---------------------------------------------------------------------------
// Helper: mount a component that calls useSoroStreamClient() inside setup()
// and returns the result (or rethrows).  Returns the thrown error, or null.
// ---------------------------------------------------------------------------
function captureErrorFromSetup(setupFn: () => unknown): Error | null {
  let caught: Error | null = null;

  const TestComponent = defineComponent({
    setup() {
      try {
        setupFn();
      } catch (err) {
        caught = err instanceof Error ? err : new Error(String(err));
      }
      return () => h('div');
    },
  });

  const app = createApp(TestComponent);
  // Suppress Vue's own console.warn for uncaught setup errors in tests.
  app.config.warnHandler = () => {};
  app.config.errorHandler = (err) => {
    caught = err instanceof Error ? err : new Error(String(err));
  };

  const div = document.createElement('div');
  app.mount(div);
  app.unmount();

  return caught;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSoroStreamClient (#801)', () => {
  it('throws a clear, actionable error when the plugin has NOT been installed', () => {
    // Call useSoroStreamClient() inside a component that did NOT install
    // SoroStreamPlugin first.  The error should name the missing installation
    // step, not produce a vague "undefined is not an object" failure.
    const err = captureErrorFromSetup(() => useSoroStreamClient());

    expect(err).toBeInstanceOf(Error);
    // The message must mention the plugin installation so the developer knows
    // exactly what is wrong.
    expect(err!.message).toMatch(/SoroStreamPlugin/i);
    // It should also name the composable so the stack-trace context is clear.
    expect(err!.message).toMatch(/useSoroStreamClient/i);
  });

  it('error message contains actionable guidance (app.use)', () => {
    const err = captureErrorFromSetup(() => useSoroStreamClient());

    expect(err).not.toBeNull();
    // Must mention app.use so the developer knows the remediation.
    expect(err!.message).toMatch(/app\.use/i);
  });

  it('returns the injected client when SoroStreamPlugin IS installed (happy path)', () => {
    const mockClient = makeMockClient();
    let resolvedClient: SoroStreamClient | null = null;

    const TestComponent = defineComponent({
      setup() {
        resolvedClient = useSoroStreamClient();
        return () => h('div');
      },
    });

    const app = createApp(TestComponent);
    // Install the plugin BEFORE mounting.
    app.use(SoroStreamPlugin, { client: mockClient });

    const div = document.createElement('div');
    app.mount(div);
    app.unmount();

    // The composable must return the exact same client instance that was
    // provided to the plugin.
    expect(resolvedClient).toBe(mockClient);
  });

  it('does NOT throw when the plugin is correctly installed (happy path — no error)', () => {
    const mockClient = makeMockClient();

    const err = captureErrorFromSetup(() => {
      // This runs inside a component that has the plugin installed — we wire
      // it up explicitly in the helper below rather than using captureErrorFromSetup
      // because that helper does not install the plugin.  The purpose here is
      // to contrast the error case: we confirm the happy path returns without
      // throwing.
      //
      // (Covered more directly by the test above; this test asserts the
      // negative — no error is set — in the no-plugin case to make the
      // difference explicit.)
    });

    // No setup function was called in the no-op above — no error expected.
    expect(err).toBeNull();

    // Separately, verify the plugin-installed path produces no error.
    let thrownInPluginPath: Error | null = null;
    const PluginComponent = defineComponent({
      setup() {
        try {
          useSoroStreamClient();
        } catch (e) {
          thrownInPluginPath = e instanceof Error ? e : new Error(String(e));
        }
        return () => h('div');
      },
    });
    const app = createApp(PluginComponent);
    app.use(SoroStreamPlugin, { client: mockClient });
    app.config.warnHandler = () => {};
    const div = document.createElement('div');
    app.mount(div);
    app.unmount();

    expect(thrownInPluginPath).toBeNull();
  });

  it('SoroStreamPlugin.install throws when no client option is provided', () => {
    const app = createApp({ setup: () => () => h('div') });
    expect(() =>
      app.use(SoroStreamPlugin, { client: undefined as unknown as SoroStreamClient }),
    ).toThrow(/client.*required/i);
  });
});
