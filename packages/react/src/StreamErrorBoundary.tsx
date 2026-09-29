import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface StreamErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered instead of `children` after an error. Receives the error and a `reset` callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Called once per caught error — use it to report to your logging service. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Called after `reset()` clears the error, before children re-render. */
  onReset?: () => void;
}

interface StreamErrorBoundaryState {
  error: Error | null;
}

/**
 * Error boundary for components that use the SoroStream hooks. A failure in a
 * hook (or its component) renders `fallback` instead of unmounting the whole
 * tree.
 *
 * @example
 * ```tsx
 * <StreamErrorBoundary fallback={(err, reset) => <Retry error={err} onRetry={reset} />}>
 *   <StreamCard streamId={id} />
 * </StreamErrorBoundary>
 * ```
 */
export class StreamErrorBoundary extends Component<
  StreamErrorBoundaryProps,
  StreamErrorBoundaryState
> {
  state: StreamErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): StreamErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(error, this.reset) : (fallback ?? null);
    }
    return this.props.children;
  }
}
