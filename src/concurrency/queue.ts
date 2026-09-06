import { ApiError } from '../errors/api-error.js';

interface QueueOptions {
  maxConcurrent: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
}

/**
 * Shared semaphore/queue used by BOTH compat routes (PRD §6.6) — they
 * ultimately drive the same underlying Claude invocations, so the ceiling
 * must be shared, not per-route.
 */
export class ConcurrencyQueue {
  private active = 0;
  private queued = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly opts: QueueOptions) {}

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queued };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.maxConcurrent) {
      if (this.queued >= this.opts.maxQueueSize) {
        throw new ApiError('rate_limit_error', 'Gateway concurrency queue is full, retry shortly', { retryAfterSeconds: 5 });
      }
      this.queued++;
      try {
        await this.waitForSlot();
      } finally {
        this.queued--;
      }
    }

    this.active++;
    try {
      return await this.withTimeout(fn());
    } finally {
      this.active--;
      this.releaseNextWaiter();
    }
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private releaseNextWaiter(): void {
    const next = this.waiters.shift();
    if (next) next();
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError('provider_error', `Request exceeded REQUEST_TIMEOUT_MS (${this.opts.requestTimeoutMs}ms)`)), this.opts.requestTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
