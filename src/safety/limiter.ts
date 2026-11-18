export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number,
  ) {}

  tryTake(key: string, max: number): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((stamp) => now - stamp < this.windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
