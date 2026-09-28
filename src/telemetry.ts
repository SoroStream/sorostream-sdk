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

/** Options controlling how finished spans are batched before export (issue #623). */
export interface TelemetryBatchOptions {
  /** Number of finished spans that triggers a flush (default: 50). */
  maxBatchSize?: number;
  /** Maximum time in ms a finished span waits before being flushed (default: 5000). */
  flushIntervalMs?: number;
}

interface PendingSpan {
  span: Span;
  attributes?: Attributes;
  endTime: number;
}

export class Telemetry {
  private tracer: Tracer | null = null;
  readonly enabled: boolean;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private pending: PendingSpan[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(enabled: boolean, batch: TelemetryBatchOptions = {}) {
    this.enabled = enabled;
    this.maxBatchSize = Math.max(1, batch.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(0, batch.flushIntervalMs ?? 5_000);
    if (enabled) {
      const otel = getOtel();
      if (otel) {
        this.tracer = otel.trace.getTracer('@sorostream/sdk', '0.1.0');
      }
    }
  }

  startSpan(name: string, options?: SpanOptions): Span | null {
    if (!this.tracer) return null;
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

  setAttributes(span: Span | null, attributes: Attributes): void {
    if (!span) return;
    span.setAttributes(attributes);
  }

  recordError(span: Span | null, error: Error): void {
    if (!span) return;
    span.recordException(error);
    span.setAttribute('error', true);
  }
}
