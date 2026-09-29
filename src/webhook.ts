import type { StreamEvent, StreamEventFilter, StreamSubscription, WebhookConfig } from './types.js';
import type { SoroStreamClient } from './SoroStreamClient.js';

/**
 * Forwards stream lifecycle events to an external HTTP webhook URL.
 *
 * This is a reference integration intended for non-JS backends
 * (e.g. a payroll system) that need to react to stream lifecycle
 * changes without embedding the SDK.
 *
 * @example
 * ```ts
 * const forwarder = new WebhookForwarder(client, {
 *   url: "https://payroll.example.com/webhooks/sorostream",
 *   headers: { "Authorization": "Bearer secret-token" },
 *   retries: 3,
 * });
 *
 * forwarder.start({ sender: "GPAY...SENDER" });
 * // later: forwarder.stop();
 * ```
 */
export class WebhookForwarder {
  private client: SoroStreamClient;
  private config: WebhookConfig;
  private subscription: StreamSubscription | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(client: SoroStreamClient, config: WebhookConfig) {
    this.client = client;
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Begins forwarding events matching the given filter to the webhook URL.
   */
  start(filter?: StreamEventFilter): void {
    if (this.subscription) return;

    this.subscription = this.client.subscribeEvents(filter ?? {}, (event) => {
      this.forward(event);
    });
  }

  /**
   * Stops forwarding events.
   */
  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  private async forward(event: StreamEvent): Promise<void> {
    const maxRetries = this.config.retries ?? 3;
    const delay = this.config.retryDelayMs ?? 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(this.config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.config.headers,
          },
          body: JSON.stringify({
            event: event.type,
            stream_id: event.streamId,
            tx_hash: event.txHash,
            ledger: event.ledger,
            timestamp: new Date(event.timestamp).toISOString(),
            data: event.data,
          }),
        });

        if (response.ok) return;

        // Non-retryable status codes
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return;
        }
      } catch {
        // Network error — will retry
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay * Math.pow(2, attempt)));
      }
    }
  }
}

// ── Issue #440: WebhookEmitter ────────────────────────────────────────────────

/**
 * Configuration for `WebhookEmitter`.
 */
export interface WebhookEmitterConfig {
  /** Endpoint URL that will receive HTTP POST payloads. */
  url: string;
  /**
   * HMAC-SHA256 secret for signing payloads.
   * When provided, each request includes an `X-SoroStream-Signature` header
   * containing the hex-encoded HMAC of the serialised payload.
   */
  secret?: string;
  /** Additional HTTP headers to include on every request. */
  headers?: Record<string, string>;
  /** How often (ms) to poll stream state for changes. Default: 10000. */
  pollIntervalMs?: number;
  /** Number of delivery retries on transient failure. Default: 3. */
  retries?: number;
  /** Initial retry delay in ms (doubles on each attempt). Default: 1000. */
  retryDelayMs?: number;
  /** Injectable `fetch` implementation. Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/** Shape of a stream-state-change payload delivered by `WebhookEmitter`. */
export interface WebhookEmitterPayload {
  stream_id: string;
  previous_status: string | null;
  current_status: string;
  timestamp: string;
  stream: unknown;
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Polls one or more stream IDs for state changes and delivers signed HTTP POST
 * payloads to a configured endpoint whenever a stream's `status` changes.
 *
 * Unlike `WebhookForwarder` (which relies on the event-subscription
 * infrastructure), `WebhookEmitter` is purely polling-based and therefore
 * works in server-side environments that have no WebSocket or persistent
 * connection.
 *
 * @example
 * ```ts
 * const emitter = new WebhookEmitter(client, {
 *   url: 'https://my-server.example.com/hooks/sorostream',
 *   secret: process.env.WEBHOOK_SECRET,
 *   pollIntervalMs: 15_000,
 * });
 * emitter.start(['42', '43']);
 * // later …
 * emitter.stop();
 * ```
 */
export class WebhookEmitter {
  private readonly pollIntervalMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly previousStatuses = new Map<string, string>();
  private streamIds: string[] = [];

  constructor(
    private readonly client: SoroStreamClient,
    private readonly config: WebhookEmitterConfig,
  ) {
    this.pollIntervalMs = config.pollIntervalMs ?? 10_000;
    this.retries = config.retries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1_000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Begin polling the given stream IDs for state changes.
   * Calling `start` while already running replaces the watched stream list.
   */
  start(streamIds: string[]): void {
    this.stop();
    this.streamIds = streamIds;
    this.previousStatuses.clear();
    // Kick off an initial poll immediately, then on interval
    void this.poll();
    this.timerId = setInterval(() => void this.poll(), this.pollIntervalMs);
    // In Node.js, prevent the interval from keeping the process alive
    (this.timerId as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop all polling. */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.streamIds = [];
    this.previousStatuses.clear();
  }

  private async poll(): Promise<void> {
    await Promise.all(this.streamIds.map((id) => this.checkStream(id)));
  }

  private async checkStream(streamId: string): Promise<void> {
    let stream: { status?: unknown } & Record<string, unknown>;
    try {
      stream = (await this.client.getStream(streamId)) as unknown as typeof stream;
    } catch {
      // Stream not found or transient network error — skip this cycle
      return;
    }

    const currentStatus = String(stream.status ?? 'unknown');
    const previousStatus = this.previousStatuses.get(streamId) ?? null;

    // Only deliver when status has actually changed
    if (previousStatus === currentStatus) return;

    this.previousStatuses.set(streamId, currentStatus);

    const payload: WebhookEmitterPayload = {
      stream_id: streamId,
      previous_status: previousStatus,
      current_status: currentStatus,
      timestamp: new Date().toISOString(),
      stream,
    };

    await this.deliver(payload);
  }

  private async deliver(payload: WebhookEmitterPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const { secret, url, headers } = this.config;

    const extraHeaders: Record<string, string> = { ...headers };
    if (secret) {
      extraHeaders['X-SoroStream-Signature'] = await hmacSign(secret, body);
    }

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body,
        });
        if (response.ok) return;
        // Non-retryable 4xx errors (except 429 Too Many Requests)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return;
      } catch {
        // Network error — will retry
      }
      if (attempt < this.retries) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * Math.pow(2, attempt)));
      }
    }
  }
}
