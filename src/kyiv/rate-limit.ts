export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding-window limiter: at most `limit()` acquisitions in any 60-second window.
 * Callers wait (FIFO) instead of failing. The limit is read on every call so admins
 * can retune it live.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: () => number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
    private readonly windowMs = 60_000,
  ) {}

  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.stamps.length && this.stamps[0]! <= now - this.windowMs) this.stamps.shift();
      if (this.stamps.length < Math.max(1, this.limit())) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(this.stamps[0]! + this.windowMs - now);
    }
  }

  /** Acquisitions in the current window (for diagnostics). */
  inWindow(): number {
    const now = this.now();
    return this.stamps.filter((t) => t > now - this.windowMs).length;
  }
}
