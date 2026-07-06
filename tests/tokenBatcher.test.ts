import { describe, it, expect, vi } from "vitest";
import { TokenBatcher, type BatchScheduler } from "../lib/tokenBatcher";

/** A scheduler that runs callbacks only when the test calls `tick`. */
function manualScheduler(): BatchScheduler & {
  tick: () => void;
  scheduled: number;
} {
  let cb: (() => void) | null = null;
  return {
    scheduled: 0,
    schedule(fn) {
      this.scheduled += 1;
      cb = fn;
      return this.scheduled;
    },
    cancel() {
      cb = null;
    },
    tick() {
      const run = cb;
      cb = null;
      run?.();
    },
  };
}

describe("TokenBatcher", () => {
  it("coalesces many adds into a single flush per tick", () => {
    const scheduler = manualScheduler();
    const onFlush = vi.fn();
    const batcher = new TokenBatcher(scheduler, onFlush);

    batcher.add("m1");
    batcher.add("m1");
    batcher.add("m2");
    expect(onFlush).not.toHaveBeenCalled(); // nothing until the tick
    expect(scheduler.scheduled).toBe(1); // only one frame scheduled

    scheduler.tick();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect([...onFlush.mock.calls[0]![0]]).toEqual(["m1", "m2"]);
  });

  it("schedules a fresh flush after the previous one drained", () => {
    const scheduler = manualScheduler();
    const onFlush = vi.fn();
    const batcher = new TokenBatcher(scheduler, onFlush);

    batcher.add("m1");
    scheduler.tick();
    batcher.add("m2");
    scheduler.tick();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect([...onFlush.mock.calls[1]![0]]).toEqual(["m2"]);
  });

  it("flush() drains synchronously and cancels the scheduled tick", () => {
    const scheduler = manualScheduler();
    const onFlush = vi.fn();
    const batcher = new TokenBatcher(scheduler, onFlush);

    batcher.add("m1");
    batcher.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);

    scheduler.tick(); // already cancelled -> no second flush
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing pending is a no-op", () => {
    const scheduler = manualScheduler();
    const onFlush = vi.fn();
    new TokenBatcher(scheduler, onFlush).flush();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("dispose() drops pending work without flushing", () => {
    const scheduler = manualScheduler();
    const onFlush = vi.fn();
    const batcher = new TokenBatcher(scheduler, onFlush);

    batcher.add("m1");
    batcher.dispose();
    scheduler.tick();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
