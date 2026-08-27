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
