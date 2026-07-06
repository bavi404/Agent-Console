import { describe, it, expect } from "vitest";
import {
  diffLines,
  diffStat,
  commonPrefixLength,
  commonSuffixLength,
} from "../lib/diff";

describe("diffLines", () => {
  it("returns all-equal ops for identical input", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.type === "eq")).toBe(true);
    expect(ops.map((o) => o.value)).toEqual(["a", "b", "c"]);
  });

  it("detects pure additions", () => {
    const ops = diffLines("a\nc", "a\nb\nc");
    expect(ops).toEqual([
      { type: "eq", value: "a" },
      { type: "add", value: "b" },
      { type: "eq", value: "c" },
    ]);
  });

  it("detects pure deletions", () => {
    const ops = diffLines("a\nb\nc", "a\nc");
    expect(ops).toEqual([
      { type: "eq", value: "a" },
      { type: "del", value: "b" },
      { type: "eq", value: "c" },
    ]);
  });

  it("handles a replacement as delete + add", () => {
    const ops = diffLines("hello\nworld", "hello\nthere");
    expect(ops).toContainEqual({ type: "del", value: "world" });
    expect(ops).toContainEqual({ type: "add", value: "there" });
    const stat = diffStat(ops);
    expect(stat).toEqual({ added: 1, removed: 1 });
  });

  it("handles empty sides", () => {
    expect(diffStat(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 0 });
    expect(diffStat(diffLines("a\nb", ""))).toEqual({ added: 0, removed: 2 });
    expect(diffLines("", "")).toEqual([]);
  });
});

describe("common affix helpers", () => {
  it("measures a shared prefix", () => {
    expect(commonPrefixLength("foobar", "foobaz")).toBe(5);
    expect(commonPrefixLength("abc", "xyz")).toBe(0);
    expect(commonPrefixLength("", "abc")).toBe(0);
  });

  it("measures a shared suffix that does not overlap the prefix", () => {
    expect(commonSuffixLength("foobar", "bazbar")).toBe(3);
    const prefix = commonPrefixLength("abcde", "abxde");
    expect(commonSuffixLength("abcde", "abxde", prefix)).toBe(2);
  });
});
