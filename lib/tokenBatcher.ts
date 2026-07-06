/**
 * TokenBatcher — coalesces a burst of TOKEN events into a single flush.
 *
 * At 30+ tokens/sec, writing to Zustand per token would force React to reconcile
 * the timeline/chat on every frame multiple times. Batching to one flush per
 * animation frame caps store writes (~60/sec max) and keeps the virtualized
 * lists smooth — only the active stream row repaints each flush.
 */

export interface BatchScheduler {
  /** Schedule `cb` to run later; return a handle that `cancel` understands. */
  schedule(cb: () => void): number;
  cancel(handle: number): void;
}

export class TokenBatcher {
  private pending = new Set<string>();
  private handle: number | null = null;

  constructor(
    private readonly scheduler: BatchScheduler,
    private readonly onFlush: (ids: ReadonlySet<string>) => void,
  ) {}

  /** Mark a stream as dirty and ensure a flush is scheduled. */
  add(id: string): void {
    this.pending.add(id);
    if (this.handle === null) {
      this.handle = this.scheduler.schedule(() => {
        this.handle = null;
        this.flush();
      });
    }
  }

  /** Flush now (also called by the scheduler). No-op when nothing is pending. */
  flush(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    if (this.pending.size === 0) return;
    const ids = this.pending;
    this.pending = new Set();
    this.onFlush(ids);
  }

  /** Cancel any pending flush and drop buffered ids (on teardown). */
  dispose(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    this.pending.clear();
  }
}

/** Browser scheduler that batches per animation frame. */
export const rafScheduler: BatchScheduler = {
  schedule: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};
