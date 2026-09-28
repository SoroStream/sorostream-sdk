import { rpc } from '@stellar/stellar-sdk';
import { getDefaultWebSocketFactory, type WebSocketFactory } from './adapters.js';
import type {
  RpcTransportAdapter,
  RpcTransportGetEventsRequest,
  RpcTransportInitContext,
} from './transport.js';

/** Reconnect backoff for {@link WebSocketTransportAdapter}. */
export interface WebSocketTransportReconnectOptions {
  /** Max consecutive reconnect attempts before falling back to HTTP polling (default: 5). */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in ms (default: 30000). */
  maxDelayMs?: number;
}

/** Options for {@link WebSocketTransportAdapter}. */
export interface WebSocketTransportOptions {
  /** WebSocket endpoint of an RPC node that supports event streaming. */
  wsUrl: string;
  /** HTTP transport used for every non-subscription call (e.g. `createDefaultRpcTransport(url)`). */
  http: RpcTransportAdapter;
  /** Reconnect policy applied when the socket drops. */
  reconnect?: WebSocketTransportReconnectOptions;
  /** Overrides the global `WebSocket` constructor. */
  webSocketFactory?: WebSocketFactory;
}

/**
 * RPC transport that delivers contract events over a WebSocket instead of
 * HTTP polling (issue #331). All request/response calls are delegated to the
 * wrapped HTTP transport. When the socket cannot be (re)established within
 * the configured reconnect attempts, the subscription reports an error and
 * the event poller transparently falls back to HTTP polling.
 *
 * The socket speaks JSON-RPC: it sends
 * `{"method":"subscribe","params":{"type":"events","filters":[...]}}` and
 * accepts notifications whose `params.result` (or `result`) is a single
 * raw event or an array of raw events in `getEvents` JSON shape.
 */
export class WebSocketTransportAdapter implements RpcTransportAdapter {
  private readonly wsUrl: string;
  private readonly http: RpcTransportAdapter;
  private readonly factory: WebSocketFactory | null;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly closers = new Set<() => void>();

  constructor(options: WebSocketTransportOptions) {
    this.wsUrl = options.wsUrl;
    this.http = options.http;
    this.factory = options.webSocketFactory ?? getDefaultWebSocketFactory();
    this.maxAttempts = options.reconnect?.maxAttempts ?? 5;
    this.baseDelayMs = options.reconnect?.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
  }

  get serverURL(): URL | undefined {
    return this.http.serverURL;
  }

  init(context: RpcTransportInitContext): Promise<void> | void {
    return this.http.init?.(context);
  }

  getAccount(address: string) {
    return this.http.getAccount(address);
  }
  getHealth() {
    return this.http.getHealth();
  }
  getLatestLedger() {
    return this.http.getLatestLedger();
  }
  getTransaction(hash: string) {
    return this.http.getTransaction(hash);
  }
  simulateTransaction(tx: Parameters<RpcTransportAdapter['simulateTransaction']>[0]) {
    return this.http.simulateTransaction(tx);
  }
  prepareTransaction(tx: Parameters<RpcTransportAdapter['prepareTransaction']>[0]) {
    return this.http.prepareTransaction(tx);
  }
  sendTransaction(tx: Parameters<RpcTransportAdapter['sendTransaction']>[0]) {
    return this.http.sendTransaction(tx);
  }
  getEvents(request: RpcTransportGetEventsRequest) {
    return this.http.getEvents(request);
  }

  subscribeEvents(
    request: Pick<RpcTransportGetEventsRequest, 'filters'>,
    onEvent: (event: rpc.Api.EventResponse) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;

    const close = () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      socket?.close();
      this.closers.delete(close);
    };

    const fail = (err: unknown) => {
      close();
      onError(err);
    };

    const scheduleReconnect = (err: unknown) => {
      if (closed) return;
      attempts++;
      if (attempts > this.maxAttempts) return fail(err);
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempts - 1));
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (closed) return;
      if (!this.factory) return fail(new Error('WebSocket is not available in this environment'));
      let ws: WebSocket;
      try {
        ws = this.factory(this.wsUrl);
      } catch (err) {
        return scheduleReconnect(err);
      }
      socket = ws;
      ws.onopen = () => {
        attempts = 0;
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'subscribe',
            params: { type: 'events', filters: request.filters },
          }),
        );
      };
      ws.onmessage = (msg: MessageEvent) => {
        let payload: { result?: unknown; params?: { result?: unknown } };
        try {
          payload = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        const result = payload.params?.result ?? payload.result;
        if (!result || typeof result !== 'object') return;
        const events = Array.isArray(result) ? result : [result];
        const raw = events.filter(
          (e): e is rpc.Api.RawEventResponse => !!e && typeof e === 'object' && 'topic' in e,
        );
        let parsed: rpc.Api.EventResponse[];
        try {
          parsed = rpc.parseRawEvents({ latestLedger: 0, cursor: '', events: raw }).events;
        } catch {
          return;
        }
        for (const event of parsed) onEvent(event);
      };
      ws.onclose = () => {
        if (socket === ws) scheduleReconnect(new Error('WebSocket closed'));
      };
      ws.onerror = () => {
        // onclose follows onerror and drives the reconnect.
      };
    };

    this.closers.add(close);
    connect();
    return close;
  }

  async teardown(): Promise<void> {
    for (const close of [...this.closers]) close();
    await this.http.teardown?.();
  }
}
