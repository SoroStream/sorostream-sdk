/** Issue #331: WebSocketTransportAdapter push delivery, reconnect and fallback. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { WebSocketTransportAdapter } from '../src/wsTransport.js';
import { EventPoller } from '../src/events.js';
import type { RpcTransportAdapter } from '../src/transport.js';

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {}
}

const rawEvent = {
  type: 'contract',
  ledger: 10,
  ledgerClosedAt: '2026-01-01T00:00:00Z',
  contractId: CONTRACT,
  id: '1',
  pagingToken: '1',
  inSuccessfulContractCall: true,
  txHash: 'abc',
  topic: [
    nativeToScVal('StreamCreated', { type: 'symbol' }).toXDR('base64'),
    nativeToScVal(7n, { type: 'u64' }).toXDR('base64'),
  ],
  value: nativeToScVal({ amount: 1n }).toXDR('base64'),
};

function makeHttp(): RpcTransportAdapter {
  return {
    getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '' }),
  } as unknown as RpcTransportAdapter;
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
});

describe('WebSocketTransportAdapter (#331)', () => {
  it('delivers events over WebSocket without polling', () => {
    const http = makeHttp();
    const transport = new WebSocketTransportAdapter({
      wsUrl: 'wss://rpc.example',
      http,
      webSocketFactory: () => new FakeSocket() as unknown as WebSocket,
    });
    const poller = new EventPoller(transport, CONTRACT);
    const received: string[] = [];
    poller.subscribe('k', { filter: () => true, callback: (e) => received.push(e.streamId) });

    const ws = FakeSocket.instances[0]!;
    ws.onopen!();
    expect(JSON.parse(ws.sent[0]!).method).toBe('subscribe');
    ws.onmessage!({ data: JSON.stringify({ params: { result: rawEvent } }) });

    expect(received).toEqual(['7']);
    expect(http.getEvents).not.toHaveBeenCalled();
    poller.destroy();
  });

  it('reconnects with backoff, then falls back to HTTP polling', () => {
    vi.useFakeTimers();
    const http = makeHttp();
    const transport = new WebSocketTransportAdapter({
      wsUrl: 'wss://rpc.example',
      http,
      reconnect: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 },
      webSocketFactory: () => new FakeSocket() as unknown as WebSocket,
    });
    const poller = new EventPoller(transport, CONTRACT);
    poller.subscribe('k', { filter: () => true, callback: () => {} });

    FakeSocket.instances[0]!.onclose!();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.onclose!();
    vi.advanceTimersByTime(200);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(http.getEvents).not.toHaveBeenCalled();

    FakeSocket.instances[2]!.onclose!();
    expect(http.getEvents).toHaveBeenCalled();
    poller.destroy();
  });
});
