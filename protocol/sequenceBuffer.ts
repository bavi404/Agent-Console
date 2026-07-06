/**
 * SequenceBuffer — ordered, gap-aware delivery of sequenced events.
 *
 * A pull-based companion to ReorderBuffer. Where ReorderBuffer pushes whatever
 * is deliverable, SequenceBuffer hands control to the caller:
 *
 *   buf.insert(event);            // accept in any order, dedupe, buffer
 *   let next;
 *   while ((next = buf.nextProcessable())) {  // peek the in-order head
 *     handle(next);
 *     buf.markProcessed();        // commit; advance the watermark
 *   }
 *
 * Guarantees:
 *   - Events are released strictly in ascending `seq` order with no gaps.
 *   - Duplicates and already-processed (stale) events are rejected.
 *   - Out-of-order arrivals are buffered until the gap before them fills.
 *
 * Pure TypeScript, no framework imports. Backed by a `Map<number, T>`.
 */

export interface HasSeq {
  seq: number;
}

/** Outcome of an `insert` call. */
export type InsertResult =
  | "buffered" // newly stored, awaiting (possibly immediate) processing
  | "duplicate" // a not-yet-processed event with this seq is already buffered
  | "stale"; // seq has already been processed (<= highest processed)

export class SequenceBuffer<T extends HasSeq> {
  private readonly buffer = new Map<number, T>();
  private highest: number;
  private readonly start: number;

  /**
   * @param startSeq The highest sequence considered already processed before
   *   this buffer existed. The first releasable event is `startSeq + 1`.
   *   Defaults to 0 (so the stream is expected to begin at seq 1).
   */
  constructor(startSeq = 0) {
    this.start = startSeq;
    this.highest = startSeq;
  }

  /** Highest sequence number that has been processed (the watermark). */
  get highestProcessed(): number {
    return this.highest;
  }

  /** Count of events currently buffered (accepted but not yet processed). */
  get size(): number {
    return this.buffer.size;
  }

  /** Is an event with this seq currently buffered? */
  isBuffered(seq: number): boolean {
    return this.buffer.has(seq);
  }

  /** Lowest seq currently held waiting on a gap. */
  minBufferedSeq(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const seq of this.buffer.keys()) {
      if (seq < min) min = seq;
    }
    return min;
  }

  /** Buffered events exist but the in-order head (`highest + 1`) is missing. */
  isGapBlocked(): boolean {
    return this.buffer.size > 0 && !this.buffer.has(this.highest + 1);
  }

  /**
   * Accept an incoming event. Idempotent for duplicates and stale events.
   * Order of arrival does not matter.
   */
  insert(event: T): InsertResult {
    const { seq } = event;

    // Already processed (covers duplicates of consumed events).
    if (seq <= this.highest) return "stale";

    // Already sitting in the buffer, not yet processed.
    if (this.buffer.has(seq)) return "duplicate";

    this.buffer.set(seq, event);
    return "buffered";
  }

  /**
   * Peek the next event that can be processed in order — i.e. the one at
   * `highestProcessed + 1` — without consuming it. Returns `undefined` when the
   * head is missing (a gap) or the buffer is empty.
   *
   * Pure: calling it repeatedly returns the same event until `markProcessed`.
   */
  nextProcessable(): T | undefined {
    return this.buffer.get(this.highest + 1);
  }

  /**
   * Commit the current processable head: remove it from the buffer and advance
   * the watermark. Throws if there is nothing processable, so misuse surfaces
   * immediately rather than silently corrupting ordering.
   */
  markProcessed(): T {
    const next = this.highest + 1;
    const event = this.buffer.get(next);
    if (event === undefined) {
      throw new Error(
        `SequenceBuffer.markProcessed(): no processable event at seq ${next}`,
      );
    }
    this.buffer.delete(next);
    this.highest = next;
    return event;
  }

  /**
   * Convenience: release every contiguous event currently available, in order.
   * Built on `nextProcessable` + `markProcessed`, so it preserves all the same
   * guarantees. Stops at the first gap.
   */
  drain(): T[] {
    const out: T[] = [];
    while (this.nextProcessable() !== undefined) {
      out.push(this.markProcessed());
    }
    return out;
  }

  /**
   * Reset to the initial state: empty the buffer and return the watermark to
   * the original `startSeq`.
   */
  clear(): void {
    this.buffer.clear();
    this.highest = this.start;
  }
}
