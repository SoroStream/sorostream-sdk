// ── Issue #212: Custom event bus integration ─────────────────────────────────

/** Unsubscribes a handler previously registered via {@link IEventBus.on}. */
export type Unsubscribe = () => void;

/**
 * Framework-agnostic pub/sub interface. Implement this to plug the SDK's
 * lifecycle events into an external event system (Redux, Zustand, a custom
 * `EventEmitter`, etc.) instead of polling for changes.
 *
 * Pass an implementation via {@link SoroStreamClientOptions.eventBus}. When
 * omitted, the client uses {@link InMemoryEventBus} by default.
 */
export interface IEventBus {
  /** Dispatches `data` to every handler registered for `event`. */
  emit(event: string, data: unknown): void;
  /** Registers `handler` for `event`. Returns a function that removes it. */
  on(event: string, handler: (data: unknown) => void): Unsubscribe;
}

/**
 * Default {@link IEventBus} implementation backed by an in-memory handler
 * registry. Used automatically when no `eventBus` is configured on the client.
 */
export class InMemoryEventBus implements IEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(data);
    }
  }

  on(event: string, handler: (data: unknown) => void): Unsubscribe {
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }
}
