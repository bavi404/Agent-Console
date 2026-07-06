import { describe, it, expect } from "vitest";
import { ReorderBuffer } from "../protocol/reorderBuffer";

interface Frame {
  seq: number;
  body: string;
}

const f = (seq: number): Frame => ({ seq, body: `#${seq}` });
const seqs = (frames: Frame[]): number[] => frames.map((x) => x.seq);

describe("ReorderBuffer", () => {
  it("delivers in-order frames immediately", () => {
    const buf = new ReorderBuffer<Frame>();
    expect(seqs(buf.push(f(1), 0))).toEqual([1]);
    expect(seqs(buf.push(f(2), 0))).toEqual([2]);
    expect(seqs(buf.push(f(3), 0))).toEqual([3]);
    expect(buf.lastDelivered).toBe(3);
    expect(buf.pending).toBe(0);
  });

  it("reassembles out-of-order frames once the gap fills", () => {
    const buf = new ReorderBuffer<Frame>();
    expect(seqs(buf.push(f(3), 0))).toEqual([]); // buffered
    expect(seqs(buf.push(f(2), 0))).toEqual([]); // buffered
    expect(buf.pending).toBe(2);
    // 1 arrives -> 1,2,3 all flush in order
    expect(seqs(buf.push(f(1), 0))).toEqual([1, 2, 3]);
    expect(buf.pending).toBe(0);
  });

  it("drops stale and duplicate frames", () => {
    const buf = new ReorderBuffer<Frame>();
    buf.push(f(1), 0);
    buf.push(f(2), 0);
    expect(seqs(buf.push(f(2), 0))).toEqual([]); // duplicate (delivered)
    expect(seqs(buf.push(f(1), 0))).toEqual([]); // stale
    expect(buf.lastDelivered).toBe(2);
  });

  it("keeps the first buffered copy when a duplicate arrives before delivery", () => {
    const buf = new ReorderBuffer<Frame>();
    expect(seqs(buf.push({ seq: 2, body: "first" }, 0))).toEqual([]);
    expect(seqs(buf.push({ seq: 2, body: "second" }, 0))).toEqual([]);
    const out = buf.push(f(1), 0);
    expect(seqs(out)).toEqual([1, 2]);
    expect(out[1]!.body).toBe("first");
  });

  it("respects a custom startSeq", () => {
    const buf = new ReorderBuffer<Frame>({ startSeq: 100 });
    expect(seqs(buf.push(f(100), 0))).toEqual([]); // stale (already delivered)
    expect(seqs(buf.push(f(101), 0))).toEqual([101]);
  });

  it("skips a gap when the buffer overflows", () => {
    const buf = new ReorderBuffer<Frame>({ maxBuffer: 3 });
    // seq 1 is missing forever; pile up 2..5 (4 held > maxBuffer 3)
    buf.push(f(2), 0);
    buf.push(f(3), 0);
    buf.push(f(4), 0);
    const out = buf.push(f(5), 0);
    expect(seqs(out)).toEqual([2, 3, 4, 5]);
    const skips = buf.takeSkips();
    expect(skips).toEqual([{ from: 1, to: 1, reason: "overflow" }]);
  });

  it("skips a gap once it ages out, via tick()", () => {
    const buf = new ReorderBuffer<Frame>({ maxGapAgeMs: 1000 });
    buf.push(f(2), 0); // waiting on 1
    expect(buf.pending).toBe(1);
    expect(seqs(buf.tick(500))).toEqual([]); // not old enough
    const out = buf.tick(1000); // aged out
    expect(seqs(out)).toEqual([2]);
    expect(buf.takeSkips()).toEqual([{ from: 1, to: 1, reason: "timeout" }]);
  });

  it("continues cleanly after skipping a gap", () => {
    const buf = new ReorderBuffer<Frame>({ maxGapAgeMs: 1000 });
    buf.push(f(2), 0);
    buf.tick(1000); // skip seq 1, deliver 2
    expect(seqs(buf.push(f(3), 1000))).toEqual([3]);
    expect(buf.lastDelivered).toBe(3);
  });

  it("drainAll releases everything in order, recording skipped gaps", () => {
    const buf = new ReorderBuffer<Frame>();
    buf.push(f(2), 0);
    buf.push(f(5), 0);
    const out = buf.drainAll();
    expect(seqs(out)).toEqual([2, 5]);
    expect(buf.takeSkips()).toEqual([
      { from: 1, to: 1, reason: "timeout" },
      { from: 3, to: 4, reason: "timeout" },
    ]);
  });
});
