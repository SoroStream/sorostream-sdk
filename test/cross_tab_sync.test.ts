/**
 * Tests for cross-tab event sync via BroadcastChannel.
 *
 * Covers the listener lifecycle bug: the `message` listener registered at
 * construction must be removed (and the channel closed) when the client is
 * destroyed, so destroyed clients can be garbage-collected and
 * re-initialisation cycles do not accumulate stale listeners.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The fake channel registry is process-global; reset it before every test so
// instance indexing and counts never leak between tests.
beforeEach(() => {
  FakeBroadcastChannel.reset();
});

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { InMemoryEventBus } from '../src/eventBus.js';
import { CrossTabSync, CrossTabEventBus } from '../src/crossTabSync.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

/** In-memory BroadcastChannel stand-in with a per-process channel registry. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static registry = new Map<string, Set<FakeBroadcastChannel>>();

  static dispatch(name: string, message: unknown): void {
    for (const channel of FakeBroadcastChannel.registry.get(name) ?? []) {
      for (const listener of channel.listeners) {
        listener({ data: message });
      }
    }
  }

  static reset(): void {
    FakeBroadcastChannel.instances = [];
    FakeBroadcastChannel.registry = new Map();
  }

  name: string;
  listeners = new Set<(event: { data: unknown }) => void>();
  closed = false;
  posted: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
    const set = FakeBroadcastChannel.registry.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.registry.set(name, set);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
    FakeBroadcastChannel.dispatch(this.name, data);
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

function makeClientOptions(overrides: Record<string, unknown> = {}) {
  return {
    network: 'testnet' as const,
    contractId: VALID_CONTRACT,
    skipPeerCheck: true,
    ...overrides,
  };
}

describe('CrossTabSync (unit)', () => {
  it('registers exactly one message listener when enabled', () => {
    const onMessage = vi.fn();
    const relay = new CrossTabSync({
      channelName: 'sorostream:testnet:abc',
      enabled: true,
      onMessage,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });

    expect(relay.active).toBe(true);
    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe('sorostream:testnet:abc');
    expect(channel.listeners.size).toBe(1);
    relay.destroy();
  });

  it('opens no channel when disabled', () => {
    const relay = new CrossTabSync({
      channelName: 'sorostream:testnet:abc',
      enabled: false,
      onMessage: vi.fn(),
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });

    expect(relay.active).toBe(false);
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
    relay.broadcast('cacheInvalidated', { reason: 'manual' }); // must not throw
  });

  it('opens no channel when the factory returns null (no BroadcastChannel)', () => {
    const relay = new CrossTabSync({
      channelName: 'sorostream:testnet:abc',
      enabled: true,
      onMessage: vi.fn(),
      broadcastChannelFactory: () => null,
    });

    expect(relay.active).toBe(false);
    relay.broadcast('cacheInvalidated', { reason: 'manual' }); // must not throw
  });

  it('delivers broadcasts to other relays but never to itself', () => {
    const onMessageA = vi.fn();
    const onMessageB = vi.fn();
    const relayA = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageA,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const relayB = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageB,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });

    relayA.broadcast('cacheInvalidated', { reason: 'manual' });

    expect(onMessageB).toHaveBeenCalledTimes(1);
    expect(onMessageB).toHaveBeenCalledWith('cacheInvalidated', { reason: 'manual' });
    expect(onMessageA).not.toHaveBeenCalled();
    relayA.destroy();
    relayB.destroy();
  });

  it('ignores messages that are not from the SDK protocol', () => {
    const onMessage = vi.fn();
    const relay = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const channel = FakeBroadcastChannel.instances[0]!;

    // Simulate an unrelated tab posting on the same channel.
    for (const listener of [...channel.listeners]) {
      listener({ data: { hello: 'from another app' } });
    }

    expect(onMessage).not.toHaveBeenCalled();
    relay.destroy();
  });

  it('destroy removes the listener, closes the channel, and stops delivery', () => {
    const onMessageA = vi.fn();
    const onMessageB = vi.fn();
    const relayA = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageA,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const relayB = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageB,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const channelA = FakeBroadcastChannel.instances[0]!;

    relayA.destroy();

    expect(relayA.active).toBe(false);
    expect(channelA.closed).toBe(true);
    expect(channelA.listeners.size).toBe(0);

    // No further delivery to a destroyed relay, and its broadcasts are no-ops.
    relayB.broadcast('cacheInvalidated', { reason: 'manual' });
    expect(onMessageA).not.toHaveBeenCalled();
    relayA.broadcast('cacheInvalidated', { reason: 'manual' });
    expect(onMessageB).not.toHaveBeenCalled();

    // Idempotent.
    relayA.destroy();
    relayB.destroy();
  });

  it('does not re-broadcast events re-emitted from a remote tab (no ping-pong)', () => {
    const innerBus = new InMemoryEventBus();
    const received: unknown[] = [];
    innerBus.on('cacheInvalidated', (data) => received.push(data));
    const relayA = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: vi.fn(),
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    // Receiving side re-emits on the inner bus only — never through a relay.
    const relayB = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: (event, data) => innerBus.emit(event, data),
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const channelB = FakeBroadcastChannel.instances[1]!;

    relayA.broadcast('cacheInvalidated', { reason: 'manual' });

    // innerBus got the event...
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ reason: 'manual' });
    // ...but relayB never posted anything back onto the channel.
    expect(channelB.posted).toHaveLength(0);
    relayA.destroy();
    relayB.destroy();
  });
});

describe('CrossTabEventBus (unit)', () => {
  it('emits locally and forwards to the relay', () => {
    const inner = new InMemoryEventBus();
    const onMessage = vi.fn();
    const relay = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage,
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const bus = new CrossTabEventBus(inner, relay);

    const received: unknown[] = [];
    bus.on('cacheInvalidated', (data) => received.push(data));
    bus.emit('cacheInvalidated', { reason: 'manual' });

    expect(received).toHaveLength(1);
    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.posted).toHaveLength(1);
    relay.destroy();
  });

  it('stops forwarding once the relay is detached', () => {
    const inner = new InMemoryEventBus();
    const relay = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: vi.fn(),
      broadcastChannelFactory: (name) => new FakeBroadcastChannel(name),
    });
    const bus = new CrossTabEventBus(inner, relay);
    const channel = FakeBroadcastChannel.instances[0]!;

    relay.destroy();
    bus.relay = null;

    bus.emit('cacheInvalidated', { reason: 'manual' });
    expect(channel.posted).toHaveLength(0);
  });
});

describe('SoroStreamClient cross-tab sync', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  afterEach(() => {
    globalThis.BroadcastChannel = originalBroadcastChannel;
    FakeBroadcastChannel.reset();
  });

  it('opens no channel when crossTabSync is not enabled', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    const client = new SoroStreamClient(makeClientOptions());
    client.destroy();
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });

  it('registers one listener per client and removes it on destroy', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    const client = new SoroStreamClient(makeClientOptions({ crossTabSync: true }));

    expect(FakeBroadcastChannel.instances).toHaveLength(1);
    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe(`sorostream:testnet:${VALID_CONTRACT}`);
    expect(channel.listeners.size).toBe(1);

    client.destroy();

    expect(channel.closed).toBe(true);
    expect(channel.listeners.size).toBe(0);
  });

  it('does not accumulate stale listeners across re-initialisation cycles', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    for (let i = 0; i < 3; i++) {
      const client = new SoroStreamClient(makeClientOptions({ crossTabSync: true }));
      client.destroy();
    }

    expect(FakeBroadcastChannel.instances).toHaveLength(3);
    for (const channel of FakeBroadcastChannel.instances) {
      expect(channel.closed).toBe(true);
      expect(channel.listeners.size).toBe(0);
    }
  });

  it('relays events between two clients and stops after destroy', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    const busA = new InMemoryEventBus();
    const busB = new InMemoryEventBus();
    const received: unknown[] = [];
    busB.on('cacheInvalidated', (data) => received.push(data));

    const clientA = new SoroStreamClient(makeClientOptions({ crossTabSync: true, eventBus: busA }));
    const clientB = new SoroStreamClient(makeClientOptions({ crossTabSync: true, eventBus: busB }));

    clientA.clearStreamCache();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ reason: 'manual', network: 'testnet' });

    // After destroy, client A must no longer relay events to other tabs.
    clientA.destroy();
    received.length = 0;
    clientA.clearStreamCache();
    expect(received).toHaveLength(0);

    clientB.destroy();
  });

  it('syncs events between two clients over the real BroadcastChannel', async () => {
    // Use the real global (Node 18+) rather than the fake stub.
    globalThis.BroadcastChannel = originalBroadcastChannel;
    const busA = new InMemoryEventBus();
    const busB = new InMemoryEventBus();
    const received: unknown[] = [];
    busB.on('cacheInvalidated', (data) => received.push(data));

    const clientA = new SoroStreamClient(makeClientOptions({ crossTabSync: true, eventBus: busA }));
    const clientB = new SoroStreamClient(makeClientOptions({ crossTabSync: true, eventBus: busB }));

    clientA.clearStreamCache();

    // Node delivers BroadcastChannel messages asynchronously.
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ reason: 'manual', network: 'testnet' });
    });

    clientA.destroy();
    clientB.destroy();
  });

  it('re-scopes the channel when the network changes', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    const client = new SoroStreamClient(makeClientOptions({ crossTabSync: true }));
    const first = FakeBroadcastChannel.instances[0]!;

    client.setNetwork('mainnet');

    expect(FakeBroadcastChannel.instances).toHaveLength(2);
    const second = FakeBroadcastChannel.instances[1]!;
    expect(first.closed).toBe(true);
    expect(first.listeners.size).toBe(0);
    expect(second.name).toBe(`sorostream:mainnet:${VALID_CONTRACT}`);
    expect(second.listeners.size).toBe(1);

    client.destroy();
    expect(second.closed).toBe(true);
  });
});
