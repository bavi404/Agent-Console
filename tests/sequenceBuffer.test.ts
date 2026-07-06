import { describe, it, expect } from "vitest";
import { SequenceBuffer } from "../protocol/sequenceBuffer";

interface Evt {
  seq: number;
  tag?: string;
}

const e = (seq: number, tag?: string): Evt =>
  tag === undefined ? { seq } : { seq, tag };
const seqs = (events: Evt[]): number[] => events.map((x) => x.seq);

/** Deterministic PRNG (mulberry32) so the chaos test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe("SequenceBuffer — basics", () => {
  it("releases in-order inserts immediately", () => {
    const buf = new SequenceBuffer<Evt>();
    expect(buf.insert(e(1))).toBe("buffered");
    expect(buf.nextProcessable()?.seq).toBe(1);
    expect(buf.markProcessed().seq).toBe(1);
    expect(buf.highestProcessed).toBe(1);
    expect(buf.nextProcessable()).toBeUndefined();
  });

  it("nextProcessable is a pure peek (no consumption)", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(1));
    expect(buf.nextProcessable()?.seq).toBe(1);
    expect(buf.nextProcessable()?.seq).toBe(1);
    expect(buf.size).toBe(1);
    expect(buf.highestProcessed).toBe(0);
  });

  it("markProcessed throws when nothing is processable", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(2)); // gap at 1
    expect(() => buf.markProcessed()).toThrow(/no processable event at seq 1/);
  });

  it("honors a custom startSeq", () => {
    const buf = new SequenceBuffer<Evt>(100);
    expect(buf.insert(e(100))).toBe("stale");
    expect(buf.insert(e(101))).toBe("buffered");
    expect(buf.drain().map((x) => x.seq)).toEqual([101]);
  });

  it("clear() on a resumed buffer returns to the resume watermark", () => {
    const buf = new SequenceBuffer<Evt>(10);
    buf.insert(e(11));
    buf.markProcessed();
    buf.insert(e(13));

    buf.clear();

    expect(buf.highestProcessed).toBe(10);
    expect(buf.size).toBe(0);
    expect(buf.insert(e(10))).toBe("stale");
    expect(buf.insert(e(11))).toBe("buffered");
  });
});

describe("SequenceBuffer — duplicates", () => {
  it("rejects a duplicate still buffered, keeping the first", () => {
    const buf = new SequenceBuffer<Evt>();
    expect(buf.insert(e(1, "first"))).toBe("buffered");
    expect(buf.insert(e(1, "second"))).toBe("duplicate");
    expect(buf.size).toBe(1);
    expect(buf.markProcessed().tag).toBe("first");
  });

  it("rejects a duplicate of an already-processed event as stale", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(1));
    buf.markProcessed();
    expect(buf.insert(e(1))).toBe("stale");
    expect(buf.nextProcessable()).toBeUndefined();
  });

  it("emits each seq exactly once despite repeated inserts", () => {
    const buf = new SequenceBuffer<Evt>();
    for (const s of [1, 1, 2, 2, 2, 3, 1]) buf.insert(e(s));
    expect(seqs(buf.drain())).toEqual([1, 2, 3]);
  });

  it("keeps the original buffered event when a duplicate has different payload", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(2, "original"));
    expect(buf.insert(e(2, "replay"))).toBe("duplicate");
    buf.insert(e(1));

    const drained = buf.drain();
    expect(drained).toEqual([e(1), e(2, "original")]);
  });
});

describe("SequenceBuffer — reverse order", () => {
  it("reassembles a fully reversed stream", () => {
    const buf = new SequenceBuffer<Evt>();
    for (const s of [5, 4, 3, 2, 1]) buf.insert(e(s));
    expect(buf.nextProcessable()?.seq).toBe(1);
    expect(seqs(buf.drain())).toEqual([1, 2, 3, 4, 5]);
    expect(buf.highestProcessed).toBe(5);
    expect(buf.size).toBe(0);
  });
});

describe("SequenceBuffer — missing sequences", () => {
  it("buffers past a gap and releases once it fills", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(1));
    buf.insert(e(2));
    buf.insert(e(4)); // 3 is missing
    expect(seqs(buf.drain())).toEqual([1, 2]);
    expect(buf.nextProcessable()).toBeUndefined(); // stuck on gap at 3
    expect(buf.size).toBe(1); // 4 still buffered

    buf.insert(e(3)); // gap fills
    expect(seqs(buf.drain())).toEqual([3, 4]);
    expect(buf.highestProcessed).toBe(4);
  });

  it("handles multiple disjoint gaps", () => {
    const buf = new SequenceBuffer<Evt>();
    for (const s of [1, 3, 5]) buf.insert(e(s));
    expect(seqs(buf.drain())).toEqual([1]);
    buf.insert(e(2));
    expect(seqs(buf.drain())).toEqual([2, 3]);
    buf.insert(e(4));
    expect(seqs(buf.drain())).toEqual([4, 5]);
  });

  it("reports gap blocking via isGapBlocked and minBufferedSeq", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(1));
    buf.markProcessed();
    buf.insert(e(3));
    expect(buf.isGapBlocked()).toBe(true);
    expect(buf.minBufferedSeq()).toBe(3);
    buf.insert(e(2));
    expect(buf.isGapBlocked()).toBe(false);
  });
});

describe("SequenceBuffer — mixed ordering", () => {
  it("produces a strictly ascending stream from interleaved insert/drain", () => {
    const buf = new SequenceBuffer<Evt>();
    const emitted: number[] = [];

    buf.insert(e(3));
    buf.insert(e(1));
    emitted.push(...seqs(buf.drain())); // [1]
    buf.insert(e(2));
    emitted.push(...seqs(buf.drain())); // [2,3]
    buf.insert(e(2)); // stale now
    buf.insert(e(6));
    buf.insert(e(4));
    emitted.push(...seqs(buf.drain())); // [4]
    buf.insert(e(5));
    emitted.push(...seqs(buf.drain())); // [5,6]

    expect(emitted).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("clear() resets buffer and watermark to start", () => {
    const buf = new SequenceBuffer<Evt>();
    buf.insert(e(1));
    buf.markProcessed();
    buf.insert(e(5));
    buf.clear();
    expect(buf.highestProcessed).toBe(0);
    expect(buf.size).toBe(0);
    expect(buf.insert(e(1))).toBe("buffered"); // seq 1 accepted again after reset
  });
});

describe("SequenceBuffer — chaos mode", () => {
  it("never violates strict ascending order across randomized runs", () => {
    const N = 500;

    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = mulberry32(seed);
      const buf = new SequenceBuffer<Evt>();

      // Build 1..N, sprinkle in duplicates, then shuffle the arrival order.
      const arrivals: Evt[] = [];
      for (let s = 1; s <= N; s += 1) {
        arrivals.push(e(s));
        if (rand() < 0.3) arrivals.push(e(s)); // duplicate
        if (rand() < 0.1) arrivals.push(e(s)); // occasional second duplicate
      }
      const shuffled = shuffle(arrivals, rand);

      const emitted: number[] = [];
      for (const evt of shuffled) {
        buf.insert(evt);
        // Randomly drain mid-stream to interleave processing with arrival.
        if (rand() < 0.5) emitted.push(...seqs(buf.drain()));
      }
      emitted.push(...seqs(buf.drain())); // final flush

      // 1. Strictly ascending with no gaps or repeats.
      for (let i = 0; i < emitted.length; i += 1) {
        expect(emitted[i]).toBe(i + 1);
      }
      // 2. Complete: every sequence delivered exactly once.
      expect(emitted.length).toBe(N);
      expect(buf.highestProcessed).toBe(N);
      expect(buf.size).toBe(0);
    }
  });

  it("drains everything contiguous and only what is contiguous", () => {
    const rand = mulberry32(42);
    const buf = new SequenceBuffer<Evt>();
    const present = new Set<number>();

    // Insert a random subset of 1..50, missing some on purpose.
    for (let s = 1; s <= 50; s += 1) {
      if (rand() < 0.8) {
        buf.insert(e(s));
        present.add(s);
      }
    }

    // Expected contiguous prefix from 1.
    let expectedHigh = 0;
    while (present.has(expectedHigh + 1)) expectedHigh += 1;

    const drained = seqs(buf.drain());
    expect(drained).toEqual(
      Array.from({ length: expectedHigh }, (_, i) => i + 1),
    );
    expect(buf.highestProcessed).toBe(expectedHigh);
  });
});
