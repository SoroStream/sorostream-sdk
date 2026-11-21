import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InMemoryEventBus } from '../src/eventBus.js';
import { WebSocketTransportAdapter } from '../src/wsTransport.js';
import type { RpcTransportAdapter } from '../src/transport.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeSocket.instances.push(this);
  }
  send() {}
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InMemoryEventBus', () => {
  it('emit on an event with no registered handlers is a no-op (#909)', () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.emit('never-subscribed', { x: 1 })).not.toThrow();
  });

  it('unsubscribe removes only the specific handler instance (#908)', () => {
    const bus = new InMemoryEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('evt', a);
    bus.on('evt', b);
    offA();
    bus.emit('evt', 42);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(42);
  });
});

describe('WebSocketTransportAdapter', () => {
  it('backoff delays follow baseDelayMs * 2^(n-1) and are capped at maxDelayMs (#906)', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const transport = new WebSocketTransportAdapter({
      wsUrl: 'wss://rpc.example',
      http: {} as RpcTransportAdapter,
      reconnect: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300 },
      webSocketFactory: () => new FakeSocket() as unknown as WebSocket,
    });
    const onError = vi.fn();
    const stop = transport.subscribeEvents({ filters: [] }, () => {}, onError);

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1]!.onclose!();
      const delay = setTimeoutSpy.mock.calls.at(-1)![1] as number;
      delays.push(delay);
      vi.advanceTimersByTime(delay);
    }

    expect(delays).toEqual([100, 200, 300, 300, 300]);
    expect(onError).not.toHaveBeenCalled();
    stop();
    setTimeoutSpy.mockRestore();
  });

  it('teardown closes all open subscriptions before tearing down the HTTP transport (#905)', async () => {
    const order: string[] = [];
    const httpTeardown = vi.fn(async () => {
      order.push('http');
    });
    const transport = new WebSocketTransportAdapter({
      wsUrl: 'wss://rpc.example',
      http: { teardown: httpTeardown } as unknown as RpcTransportAdapter,
      webSocketFactory: () => {
        const s = new FakeSocket();
        s.close.mockImplementation(() => order.push(`ws${FakeSocket.instances.indexOf(s)}`));
        return s as unknown as WebSocket;
      },
    });

    transport.subscribeEvents(
      { filters: [] },
      () => {},
      () => {},
    );
    transport.subscribeEvents(
      { filters: [] },
      () => {},
      () => {},
    );
    await transport.teardown();

    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances[1]!.close).toHaveBeenCalledTimes(1);
    expect(httpTeardown).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['ws0', 'ws1', 'http']);
  });
});
