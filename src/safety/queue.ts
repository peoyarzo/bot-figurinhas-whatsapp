export class SendQueue {
  private active = 0;
  private pending = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly opts: {
      maxInFlight: number;
      jitterMinMs: number;
      jitterMaxMs: number;
      sleep: (ms: number) => Promise<void>;
      random: () => number;
    },
  ) {}

  size(): number {
    return this.pending + this.active;
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.pending += 1;
    return this.acquire().then(async () => {
      this.pending -= 1;
      try {
        const span = Math.max(0, this.opts.jitterMaxMs - this.opts.jitterMinMs);
        const jitter = this.opts.jitterMinMs + Math.floor(this.opts.random() * (span + 1));
        if (jitter > 0) await this.opts.sleep(jitter);
        return await job();
      } finally {
        this.release();
      }
    });
  }

  private acquire(): Promise<void> {
    if (this.active < this.opts.maxInFlight) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
