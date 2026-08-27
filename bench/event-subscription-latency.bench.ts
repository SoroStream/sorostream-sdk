/**
 * Benchmark comparing event subscription latency for WebSocket vs. HTTP polling transports.
 * Issue #347.
 *
 * Measures time from event emission to SDK callback for 100 events per transport.
 */

import { describe, bench } from "vitest";
import { watchClaimableWs } from "../src/utils.js";
import { EventPoller } from "../src/events.js";
import type { RpcTransportAdapter, RpcTransportGetEventsRequest } from "../src/transport.js";

class BenchmarkWebSocketServer {
  onMessageCb: ((event: { data: string }) => void) | null = null;
  onOpenCb: (() => void) | null = null;

  connect() {
    setTimeout(() => {
      if (this.onOpenCb) this.onOpenCb();
    }, 0);
  }

  emitEvent(value: string) {
    if (this.onMessageCb) {
      this.onMessageCb({
        data: JSON.stringify({ type: "claimable", streamId: "bench-stream", value }),
      });
    }
  }
}

class BenchmarkHttpPollingServer implements RpcTransportAdapter {
  private queue: Array<{ id: string; type: string; value: string }> = [];

  enqueueEvent(value: string) {
    this.queue.push({ id: "evt-1", type: "claimable", value });
  }

  async getEvents(_req: RpcTransportGetEventsRequest): Promise<any> {
    const events = this.queue.map((e) => ({
      id: e.id,
      type: "contract",
      ledger: 100,
      ledgerClosedAt: new Date().toISOString(),
      contractId: "C123",
      topic: ["claimable"],
      value: e.value,
      inSuccessfulContractCall: true,
      txHash: "hash-123",
    }));
    this.queue = [];
    return { events, latestLedger: 100 };
  }

  async getAccount(): Promise<any> { return {}; }
  async getHealth(): Promise<any> { return { status: "healthy" }; }
  async getLatestLedger(): Promise<any> { return { sequence: 100 }; }
  async getTransaction(): Promise<any> { return { status: "SUCCESS" }; }
  async simulateTransaction(): Promise<any> { return { status: "SUCCESS" }; }
  async prepareTransaction(tx: any): Promise<any> { return tx; }
  async sendTransaction(): Promise<any> { return { status: "PENDING", hash: "hash" }; }
}

export function runLatencyBenchmark(eventCount = 100) {
  const wsLatencies: number[] = [];
  const httpLatencies: number[] = [];

  // WebSocket Transport Latency Test
  const mockWsServer = new BenchmarkWebSocketServer();
  const mockWsFactory = () => {
    const ws: any = {
      send: () => {},
      close: () => {},
      set onopen(cb: () => void) { mockWsServer.onOpenCb = cb; },
      set onmessage(cb: (e: any) => void) { mockWsServer.onMessageCb = cb; },
    };
    mockWsServer.connect();
    return ws;
  };

  let pendingWsTimestamp = 0;
  const stopWs = watchClaimableWs(
    "wss://bench.local/ws",
    "bench-stream",
    () => {
      const latency = performance.now() - pendingWsTimestamp;
      wsLatencies.push(latency);
    },
    false,
    mockWsFactory as any
  );

  for (let i = 0; i < eventCount; i++) {
    pendingWsTimestamp = performance.now();
    mockWsServer.emitEvent(String(i * 100));
  }
  stopWs();

  // HTTP Polling Transport Latency Test
  const mockHttpServer = new BenchmarkHttpPollingServer();
  let pendingHttpTimestamp = 0;

  const poller = new EventPoller({
    server: mockHttpServer,
    contractId: "C123",
    pollIntervalMs: 5,
    onEvent: () => {
      const latency = performance.now() - pendingHttpTimestamp;
      httpLatencies.push(latency);
    },
  });

  poller.start();
  for (let i = 0; i < eventCount; i++) {
    pendingHttpTimestamp = performance.now();
    mockHttpServer.enqueueEvent(String(i * 100));
  }
  poller.destroy();

  const calcStats = (latencies: number[]) => {
    if (latencies.length === 0) return { median: 0, p99: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)]!;
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    return { median, p99 };
  };

  return {
    ws: calcStats(wsLatencies),
    http: calcStats(httpLatencies),
  };
}

describe("Event Subscription Latency Benchmark (WebSocket vs HTTP Polling)", () => {
  bench("WebSocket transport latency (100 events)", () => {
    runLatencyBenchmark(100);
  });
});
