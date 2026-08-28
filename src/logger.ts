import { redactSecretKey } from './utils.js';

export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export class NoopLogger implements Logger {
  warn(_message: string, ..._args: unknown[]): void {}
  error(_message: string, ..._args: unknown[]): void {}
}

export class SanitizingLogger implements Logger {
  constructor(private delegate: Logger) {}

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
