import { redactSecretKey } from './utils.js';

/**
 * Ordered log levels from most-verbose to most-silent.
 * Set `minLevel` to suppress noisier levels in production.
 *
 * - `'debug'`  — fine-grained diagnostic information
 * - `'info'`   — general operational messages
 * - `'warn'`   — recoverable problems / unexpected conditions
 * - `'error'`  — unrecoverable errors that need attention
 * - `'silent'` — suppress all output
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Numeric priority for each level (lower = more verbose). */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Logger interface used throughout the SDK.
 * Implement this to route SDK log output to any destination.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * A logger that silently discards every message.
 * Used as the default when no logger is configured.
 */
export class NoopLogger implements Logger {
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(_message: string, ..._args: unknown[]): void {}
  error(_message: string, ..._args: unknown[]): void {}
}

/**
 * A logger that writes to the global `console`.
 * Only emits messages whose level is >= `minLevel`.
 *
 * @example
 * ```ts
 * const logger = new ConsoleLogger('info'); // suppresses debug
 * ```
 */
export class ConsoleLogger implements Logger {
  private readonly minPriority: number;

  constructor(private readonly minLevel: LogLevel = 'info') {
    this.minPriority = LEVEL_PRIORITY[minLevel];
  }

  debug(message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY.debug >= this.minPriority) {
      console.debug(`[sorostream] ${message}`, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY.info >= this.minPriority) {
      console.info(`[sorostream] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY.warn >= this.minPriority) {
      console.warn(`[sorostream] ${message}`, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY.error >= this.minPriority) {
      console.error(`[sorostream] ${message}`, ...args);
    }
  }
}

/**
 * A logger decorator that redacts Stellar secret keys (S... strings) from
 * all log messages and arguments before forwarding them to a delegate logger.
 *
 * Wrap any `Logger` implementation to ensure secrets never reach log sinks.
 *
 * @example
 * ```ts
 * const logger = new SanitizingLogger(new ConsoleLogger('debug'));
 * ```
 */
export class SanitizingLogger implements Logger {
  constructor(private readonly delegate: Logger) {}

  debug(message: string, ...args: unknown[]): void {
    const cleanMsg = redactSecretKey(message);
    const cleanArgs = args.map((a) => (typeof a === 'string' ? redactSecretKey(a) : a));
    this.delegate.debug(cleanMsg, ...cleanArgs);
  }

  info(message: string, ...args: unknown[]): void {
    const cleanMsg = redactSecretKey(message);
    const cleanArgs = args.map((a) => (typeof a === 'string' ? redactSecretKey(a) : a));
    this.delegate.info(cleanMsg, ...cleanArgs);
  }

  warn(message: string, ...args: unknown[]): void {
    const cleanMsg = redactSecretKey(message);
    const cleanArgs = args.map((a) => (typeof a === 'string' ? redactSecretKey(a) : a));
    this.delegate.warn(cleanMsg, ...cleanArgs);
  }

  error(message: string, ...args: unknown[]): void {
    const cleanMsg = redactSecretKey(message);
    const cleanArgs = args.map((a) => (typeof a === 'string' ? redactSecretKey(a) : a));
    this.delegate.error(cleanMsg, ...cleanArgs);
  }
}

export interface CreateLoggerOptions {
  /**
   * Minimum level to emit. Messages below this level are discarded.
   * Defaults to `'info'`.
   */
  minLevel?: LogLevel;
  /**
   * When `true` (default), wraps the underlying logger in a `SanitizingLogger`
   * to redact any Stellar secret keys that might appear in log messages.
   */
  sanitize?: boolean;
  /**
   * Provide your own `Logger` implementation instead of the built-in
   * `ConsoleLogger`. When specified, `minLevel` is ignored (configure
   * the external logger directly).
   */
  delegate?: Logger;
}

/**
 * Factory that returns a ready-to-use logger.
 *
 * By default returns a sanitizing `ConsoleLogger` at `'info'` level.
 * Pass `{ minLevel: 'debug' }` for verbose output or `{ minLevel: 'silent' }`
 * to suppress everything.
 *
 * @example
 * ```ts
 * // Default — info + above, secrets redacted
 * const logger = createLogger();
 *
 * // Debug — all messages, no sanitization
 * const debugLogger = createLogger({ minLevel: 'debug', sanitize: false });
 *
 * // Bring-your-own pino/winston logger
 * const pinoLogger = createLogger({ delegate: pino() });
 * ```
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { minLevel = 'info', sanitize = true, delegate } = options;

  if (minLevel === 'silent' && !delegate) {
    return new NoopLogger();
  }

  const base: Logger = delegate ?? new ConsoleLogger(minLevel);
  return sanitize ? new SanitizingLogger(base) : base;
}
