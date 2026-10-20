import { VERSION } from './version.js';

type Attributes = Record<string, string | number | boolean>;
interface SpanOptions {
  attributes?: Attributes;
}
export interface Span {
  setAttributes(attrs: Attributes): void;
  end(endTime?: number): void;
  recordException(e: Error): void;
  setAttribute(k: string, v: unknown): void;
}
interface Tracer {
  startSpan(name: string, opts?: SpanOptions): Span;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _otelModule: any | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOtel(): any | null {
  if (_otelModule !== undefined) return _otelModule;
  try {
    _otelModule = require('@opentelemetry/api');
  } catch {
    _otelModule = null;
  }
  return _otelModule;
}

/**
 * Restricts which event types (span names) are collected: either a list of
 * allowed names or a predicate. Omit to collect every event.
 */
export type TelemetryEventFilter = readonly string[] | ((eventType: string) => boolean);

/** Options controlling telemetry behaviour beyond event collection (issue #702). */
export interface TelemetryOptions {
  /**
   * Endpoint that receives a best-effort fire-and-forget payload when the
   * page unloads with a partially-filled batch. `navigator.sendBeacon` is
   * used when available, with a `keepalive` `fetch` as fallback.
   */
  beaconUrl?: string;
}

interface PendingSpan {
  span: Span;
  attributes?: Attributes;
  endTime: number;
}

export class Telemetry {
  private tracer: Tracer | null = null;
  readonly enabled: boolean;
  private readonly eventFilter?: TelemetryEventFilter;
  private readonly beaconUrl?: string;
  private visibilityHandler: (() => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private disposed = false;

  /** Spans queued to be ended as part of the next batch (issue #623). */
  private pending: PendingSpan[] = [];
  /** Maximum number of queued spans before an immediate flush is forced. */
  private readonly maxBatchSize = 20;
  /** Timer that triggers a flush after `flushIntervalMs` of inactivity. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Milliseconds to wait before auto-flushing a non-full batch. */
  private readonly flushIntervalMs = 5_000;

  constructor(
    enabled: boolean,
    eventFilter?: TelemetryEventFilter,
    options: TelemetryOptions = {},
  ) {
    this.enabled = enabled;
    this.eventFilter = eventFilter;
    this.beaconUrl = options.beaconUrl;
    if (enabled) {
      const otel = getOtel();
      if (otel) {
        this.tracer = otel.trace.getTracer('@sorostream/sdk', VERSION);
      }
      // Issue #702: the batch timer can outlive the page; flush on unload so
      // the last partially-filled batch is not dropped.
      this.registerUnloadHandlers();
    }
  }

  /** Whether events of the given type pass the configured filter. */
  shouldCollect(eventType: string): boolean {
    const filter = this.eventFilter;
    if (!filter) return true;
    return typeof filter === 'function' ? filter(eventType) : filter.includes(eventType);
  }

  startSpan(name: string, options?: SpanOptions): Span | null {
    if (!this.tracer || !this.shouldCollect(name)) return null;
    return this.tracer.startSpan(name, options);
  }

  /**
   * Queues a span to be ended as part of the next batch instead of emitting
   * it immediately (issue #623). The original end time is preserved.
   */
  endSpan(span: Span | null, attributes?: Attributes): void {
    if (!span) return;
    this.pending.push({ span, attributes, endTime: Date.now() });
    if (this.pending.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      const t = this.flushTimer as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  /** Number of finished spans waiting to be flushed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Ends all queued spans in a single batch. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pending;
    this.pending = [];
    for (const { span, attributes, endTime } of batch) {
      if (attributes) span.setAttributes(attributes);
      span.end(endTime);
    }
  }

  /**
   * Registers best-effort unload listeners so a partially-filled batch is
   * flushed when the page is hidden or closed instead of being dropped when
   * the flush timer never fires (issue #702).
   *
   * Listeners are attached only when telemetry is enabled and the host
   * environment exposes a DOM.
   */
  private registerUnloadHandlers(): void {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') this.flushOnUnload();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.unloadHandler = () => this.flushOnUnload();
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

  /**
   * Ends the queued batch immediately and, when a beacon endpoint is
   * configured, ships a fire-and-forget copy of it with `navigator.sendBeacon`
   * (or a `keepalive` `fetch` when the beacon API is unavailable), since
   * unload-time requests must not depend on the event loop surviving
   * (issue #702).
   */
  flushOnUnload(): void {
    if (this.pending.length === 0) return;
    const payload = JSON.stringify({
      sdk: '@sorostream/sdk',
      version: VERSION,
      spanCount: this.pending.length,
      spans: this.pending.map(({ attributes, endTime }) => ({
        attributes: attributes ?? {},
        endTime,
      })),
    });
    this.flush();

    if (!this.beaconUrl) return;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        navigator.sendBeacon(this.beaconUrl, payload);
      } catch {
        // best-effort: the page is going away
      }
      return;
    }
    if (typeof fetch === 'function') {
      void fetch(this.beaconUrl, {
        method: 'POST',
        body: payload,
        keepalive: true,
        headers: { 'content-type': 'application/json' },
      }).catch(() => {
        // best-effort: the page is going away
      });
    }
  }

  /** Detaches the unload listeners and cancels the pending flush timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.unloadHandler);
    }
    this.visibilityHandler = null;
    this.unloadHandler = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  setAttributes(span: Span | null, attributes: Attributes): void {
    if (!span) return;
    span.setAttributes(attributes);
  }

  recordError(span: Span | null, error: Error): void {
    if (!span) return;
    span.recordException(new Error('Error details redacted'));
    span.setAttribute('error', true);
  }
}
