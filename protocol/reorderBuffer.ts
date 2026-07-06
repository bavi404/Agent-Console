/**
 * Sequence reorder buffer.
 *
 * The transport (WebSocket over a flaky network, multiplexed streams, retried
 * frames) can deliver messages out of order or duplicated. This buffer accepts
 * frames in any order and emits them strictly in sequence.
 *
 * Two safety valves stop a single missing frame from blocking the stream
 * forever (head-of-line blocking):
 *   - maxBuffer:   cap on how many out-of-order frames we hold.
 *   - maxGapAgeMs: how long we wait for a missing frame before skipping it.
 *
 * Pure logic: `now` is injectable so the behaviour is fully deterministic
 * under test.
 */
import { isStale } from "../lib/sequence";

export interface Sequenced {
  seq: number;
}

export interface ReorderBufferOptions {
  /** Last sequence already delivered before this buffer existed. Default 0. */
  startSeq?: number;
  /** Max out-of-order frames to hold before forcibly skipping a gap. */
  maxBuffer?: number;
  /** How long (ms) to wait on a gap before giving up on it. */
  maxGapAgeMs?: number;
}

interface Held<T> {
  item: T;
  at: number;
}

/** Emitted when the buffer abandons a gap, so callers can surface data loss. */
export interface SkippedGap {
  from: number;
  to: number;
  reason: "overflow" | "timeout" | "malformed";
}

export class ReorderBuffer<T extends Sequenced> {
  private last: number;
  private readonly maxBuffer: number;
  private readonly maxGapAgeMs: number;
  private readonly held = new Map<number, Held<T>>();
  private readonly skips: SkippedGap[] = [];

  constructor(options: ReorderBufferOptions = {}) {
    this.last = options.startSeq ?? 0;
    this.maxBuffer = options.maxBuffer ?? 256;
    this.maxGapAgeMs = options.maxGapAgeMs ?? 2000;
  }

  /** Sequence number of the most recently delivered frame. */
  get lastDelivered(): number {
    return this.last;
  }

  /** Number of frames currently buffered waiting on a gap. */
  get pending(): number {
    return this.held.size;
  }

  /**
   * Offer a frame to the buffer. Returns the frames that are now deliverable,
   * in strict sequence order (possibly empty, possibly several).
   */
  push(item: T, now: number = Date.now()): T[] {
    if (isStale(this.last, item.seq)) {
      // Duplicate or already-delivered frame; drop it.
      return [];
    }
    if (this.held.has(item.seq)) {
      // Duplicate still buffered — keep the first copy.
      return [];
    }
    this.held.set(item.seq, { item, at: now });
    return this.drain(now);
  }

  /**
   * Release any frames that have become deliverable purely due to the passage
   * of time (a gap aged out). Call this on a timer while the socket is idle.
   */
  tick(now: number = Date.now()): T[] {
    return this.drain(now);
  }

  /** Force-release every buffered frame in order, skipping all gaps. */
  drainAll(): T[] {
    const out: T[] = [];
    const seqs = [...this.held.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const held = this.held.get(seq);
      if (!held) continue;
      if (seq > this.last + 1) {
        this.skips.push({
          from: this.last + 1,
          to: seq - 1,
          reason: "timeout",
        });
      }
      this.held.delete(seq);
      this.last = seq;
      out.push(held.item);
    }
    return out;
  }

  /** Gaps the buffer gave up on, in the order they were abandoned. */
  takeSkips(): SkippedGap[] {
    return this.skips.splice(0, this.skips.length);
  }

  private drain(now: number): T[] {
    const out: T[] = [];

    for (;;) {
      // 1. Deliver everything contiguous with what we've already sent.
      let progressed = false;
      let nextHeld = this.held.get(this.last + 1);
      while (nextHeld) {
        this.held.delete(this.last + 1);
        this.last += 1;
        out.push(nextHeld.item);
        progressed = true;
        nextHeld = this.held.get(this.last + 1);
      }
      if (progressed) continue;

      if (this.held.size === 0) break;

      // 2. We're stuck on a gap. Decide whether to abandon it.
      const minSeq = this.minBufferedSeq();
      const oldest = this.oldestArrival();
      const overflow = this.held.size > this.maxBuffer;
      const timedOut = now - oldest >= this.maxGapAgeMs;

      if (!overflow && !timedOut) break;

      this.skips.push({
        from: this.last + 1,
        to: minSeq - 1,
        reason: overflow ? "overflow" : "timeout",
      });
      // Skip the gap: pretend everything up to the first buffered frame was
      // delivered, then loop to drain it.
      this.last = minSeq - 1;
    }

    return out;
  }

  private minBufferedSeq(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const seq of this.held.keys()) {
      if (seq < min) min = seq;
    }
    return min;
  }

  private oldestArrival(): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const { at } of this.held.values()) {
      if (at < oldest) oldest = at;
    }
    return oldest;
  }
}
