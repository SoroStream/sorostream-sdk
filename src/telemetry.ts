import { VERSION } from './version.js';

type Attributes = Record<string, string | number | boolean>;
interface SpanOptions {
  attributes?: Attributes;
}
interface Span {
  setAttributes(attrs: Attributes): void;
  end(): void;
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

export class Telemetry {
  private tracer: Tracer | null = null;
  readonly enabled: boolean;
  private readonly eventFilter?: TelemetryEventFilter;

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

  endSpan(span: Span | null, attributes?: Attributes): void {
    if (!span) return;
    if (attributes) span.setAttributes(attributes);
    span.end();
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
