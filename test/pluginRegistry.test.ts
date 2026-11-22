import { PluginRegistry } from '../src/pluginRegistry';

describe('PluginRegistry unregister', () => {
  it('removes a plugin from active dispatch paths when unregistered', () => {
    const registry = new PluginRegistry();

    const beforeHandler = jest.fn();
    const afterHandler = jest.fn();

    registry.register({
      name: 'test-plugin',
      runBefore: beforeHandler,
      runAfter: afterHandler,
    });

    // First dispatch: handlers should be called.
    registry.runBefore('some-event', {});
    registry.runAfter('some-event', {});

    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).toHaveBeenCalledTimes(1);

    // Unregister the plugin by name.
    const result = registry.unregister('test-plugin');
    expect(result).toBe(true);

    // Second dispatch: handlers should not be called again.
    registry.runBefore('some-event', {});
    registry.runAfter('some-event', {});

    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).toHaveBeenCalledTimes(1);
  });

  it('returns true for a known name and false for an unknown name', () => {
    const registry = new PluginRegistry();

    registry.register({
      name: 'known-plugin',
      runBefore: jest.fn(),
      runAfter: jest.fn(),
    });

    expect(registry.unregister('known-plugin')).toBe(true);
    expect(registry.unregister('unknown-plugin')).toBe(false);
  });
});