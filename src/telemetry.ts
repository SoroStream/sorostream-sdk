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

interface PendingSpan {
  span: Span;
  attributes?: Attributes;
  endTime: number;
}

export class Telemetry {
  private tracer: Tracer | null = null;
  readonly enabled: boolean;
  private readonly eventFilter?: TelemetryEventFilter;

  /** Spans queued to be ended as part of the next batch (issue #623). */
  private pending: PendingSpan[] = [];
  /** Maximum number of queued spans before an immediate flush is forced. */
  private readonly maxBatchSize = 20;
  /** Timer that triggers a flush after `flushIntervalMs` of inactivity. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Milliseconds to wait before auto-flushing a non-full batch. */
  private readonly flushIntervalMs = 5_000;

  constructor(enabled: boolean, eventFilter?: TelemetryEventFilter) {
    this.enabled = enabled;
    this.eventFilter = eventFilter;
    if (enabled) {
      const otel = getOtel();
      if (otel) {
        this.tracer = otel.trace.getTracer('@sorostream/sdk', VERSION);
      }
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
