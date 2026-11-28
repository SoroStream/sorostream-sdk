import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../src/pluginRegistry';

describe('PluginRegistry unregister', () => {
  it('removes a plugin from active dispatch paths when unregistered', async () => {
    const registry = new PluginRegistry();

    const beforeHandler = vi.fn();
    const afterHandler = vi.fn();

    registry.register({ before: beforeHandler, after: afterHandler }, { name: 'test-plugin' });

    // First dispatch: handlers should be called.
    await registry.runBefore('some-event', { method: 'some-event', args: [] });
    await registry.runAfter('some-event', { method: 'some-event', args: [] }, undefined);

    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).toHaveBeenCalledTimes(1);

    // Unregister the plugin by name.
    const result = registry.unregister('test-plugin');
    expect(result).toBe(true);

    // Second dispatch: handlers should not be called again.
    await registry.runBefore('some-event', { method: 'some-event', args: [] });
    await registry.runAfter('some-event', { method: 'some-event', args: [] }, undefined);

    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).toHaveBeenCalledTimes(1);
  });

  it('returns true for a known name and false for an unknown name', () => {
    const registry = new PluginRegistry();

    registry.register({ before: vi.fn(), after: vi.fn() }, { name: 'known-plugin' });

    expect(registry.unregister('known-plugin')).toBe(true);
    expect(registry.unregister('unknown-plugin')).toBe(false);
  });
});
