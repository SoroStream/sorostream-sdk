import { describe, it, expect, vi } from 'vitest';
import { watchClaimableWs } from '../src/utils.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  opts: unknown;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sentMessages: string[] = [];
  readyState = 1; // OPEN

  constructor(url: string, opts?: unknown) {
    this.url = url;
    this.opts = opts;
    MockWebSocket.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(msg: string) {
    this.sentMessages.push(msg);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Helper method for test to simulate incoming event
  emitMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  // Helper method for test to simulate connection close
  triggerClose() {
    this.close();
  }
}

describe('WebSocket transport adapter reconnects automatically (Issue #345)', () => {
  it('reconnects after an unexpected close and continues receiving events without duplicates', async () => {
    MockWebSocket.instances = [];
    const eventsReceived: bigint[] = [];
    const onClaimable = vi.fn((val: bigint) => {
      eventsReceived.push(val);
    });

    const webSocketFactory = (url: string, opts?: unknown) =>
      new MockWebSocket(url, opts) as unknown as WebSocket;

    const stop = watchClaimableWs(
      'wss://mock.rpc.example/ws',
      'stream-123',
      onClaimable,
      false,
      webSocketFactory,
      { reconnect: true, backoffMs: 20 },
    );

    // Wait for first connection to open
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBe(1);
    const ws1 = MockWebSocket.instances[0]!;

    // Verify subscription message sent
    expect(ws1.sentMessages).toContain(
      JSON.stringify({ type: 'subscribe', streamId: 'stream-123' }),
    );

    // Emit event 1
    ws1.emitMessage({ type: 'claimable', streamId: 'stream-123', value: '100' });
    expect(eventsReceived).toEqual([100n]);

    // Simulate unexpected disconnect
    ws1.triggerClose();

    // Wait for backoff window and reconnect
    await new Promise((r) => setTimeout(r, 50));

    // Assert second connection created (reconnected)
    expect(MockWebSocket.instances.length).toBe(2);
    const ws2 = MockWebSocket.instances[1]!;

    // Wait for ws2 to open and resubscribe
    await new Promise((r) => setTimeout(r, 10));
    expect(ws2.sentMessages).toContain(
      JSON.stringify({ type: 'subscribe', streamId: 'stream-123' }),
    );

    // Emit duplicate event 1 on reconnected socket — should be deduplicated
    ws2.emitMessage({ type: 'claimable', streamId: 'stream-123', value: '100' });
    expect(eventsReceived).toEqual([100n]); // No duplicate!

    // Emit new event 2 after reconnect
    ws2.emitMessage({ type: 'claimable', streamId: 'stream-123', value: '200' });
    expect(eventsReceived).toEqual([100n, 200n]);

    stop();
  });
});
