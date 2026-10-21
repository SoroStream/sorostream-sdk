type Task<T> = () => Promise<T>;

interface QueueItem {
  task: Task<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class RateLimiter {
  private queue: QueueItem[] = [];
  private inFlight = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 10) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Updates the concurrency limit at runtime. The new value applies to
   * subsequently dequeued items: raising the limit immediately starts queued
   * tasks up to the new ceiling, while lowering it never cancels in-flight
   * tasks — they simply must finish before fewer new ones are started.
   */
  setMaxConcurrent(maxConcurrent: number): void {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    this.maxConcurrent = maxConcurrent;
    this.drain();
  }

  /** Current concurrency limit. */
  get concurrency(): number {
    return this.maxConcurrent;
  }

  async run<T>(task: Task<T>): Promise<T> {
    if (this.inFlight < this.maxConcurrent) {
      return this.execute(task as Task<unknown>) as Promise<T>;
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  }

  private async execute<T>(task: Task<T>): Promise<T> {
    this.inFlight++;
    try {
      return await task();
    } finally {
      this.inFlight--;
      this.drain();
    }
  }

  private drain(): void {
    while (this.queue.length > 0 && this.inFlight < this.maxConcurrent) {
      const item = this.queue.shift()!;
      this.execute(item.task).then(item.resolve).catch(item.reject);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.inFlight;
  }
}
