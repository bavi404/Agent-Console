import { describe, expect, it } from "vitest";
import { gapBetween, isAhead, isNext, isStale } from "../lib/sequence";

describe("sequence helpers", () => {
  it("classifies next, stale, and ahead sequence numbers", () => {
    expect(isNext(10, 11)).toBe(true);
    expect(isNext(10, 12)).toBe(false);

    expect(isStale(10, 10)).toBe(true);
    expect(isStale(10, 9)).toBe(true);
    expect(isStale(10, 11)).toBe(false);

    expect(isAhead(10, 12)).toBe(true);
    expect(isAhead(10, 11)).toBe(false);
  });

  it("returns the exact missing range between two sequence numbers", () => {
    expect(gapBetween(10, 11)).toEqual([]);
    expect(gapBetween(10, 10)).toEqual([]);
    expect(gapBetween(10, 15)).toEqual([11, 12, 13, 14]);
  });
});
