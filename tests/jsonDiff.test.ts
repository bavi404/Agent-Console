import { describe, it, expect } from "vitest";
import {
  diffJsonValues,
  diffObjects,
  joinPath,
  isDiffEmpty,
  type JsonDiffResult,
} from "../lib/jsonDiff";
import type { JsonObject } from "../protocol/types";

function byPath<T extends { path: string }>(entries: T[], path: string): T {
  const found = entries.find((e) => e.path === path);
  if (!found) throw new Error(`no entry at path "${path}"`);
  return found;
}

function paths(result: JsonDiffResult): string[] {
  return [
    ...result.added.map((e) => e.path),
    ...result.removed.map((e) => e.path),
    ...result.changed.map((e) => e.path),
  ].sort();
}

describe("joinPath", () => {
  it("joins from the root without a leading dot", () => {
    expect(joinPath("", "a")).toBe("a");
    expect(joinPath("a", "b")).toBe("a.b");
    expect(joinPath("a.b", "0")).toBe("a.b.0");
  });
});

describe("diffJsonValues — identical values", () => {
  it("returns empty when both sides are undefined", () => {
    expect(isDiffEmpty(diffJsonValues(undefined, undefined))).toBe(true);
  });

  it("returns empty for deeply equal structures", () => {
    const old = { a: 1, b: { c: [1, 2], d: "x" } };
    const next = { a: 1, b: { c: [1, 2], d: "x" } };
    expect(isDiffEmpty(diffJsonValues(old, next))).toBe(true);
  });

  it("returns empty when both sides share the same reference", () => {
    const shared = { nested: { v: [1, 2, 3] } };
    const old: JsonObject = { keep: shared, other: 1 };
    const next: JsonObject = { keep: shared, other: 1 };
    expect(isDiffEmpty(diffJsonValues(old, next))).toBe(true);
  });
});

describe("diffJsonValues — added keys", () => {
  it("reports a top-level added key", () => {
    const result = diffJsonValues({ a: 1 }, { a: 1, b: 2 });
    expect(result.added).toHaveLength(1);
    expect(byPath(result.added, "b").value).toBe(2);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it("reports a nested added key with the full path", () => {
    const result = diffJsonValues(
      { user: { name: "Ada" } },
      { user: { name: "Ada", role: "admin" } },
    );
    expect(byPath(result.added, "user.role").value).toBe("admin");
  });

  it("reports a wholly new subtree as one added entry at the container path", () => {
    const subtree = { x: 1, y: { z: 2 } };
    const result = diffJsonValues({}, { branch: subtree });
    expect(result.added).toHaveLength(1);
    expect(byPath(result.added, "branch").value).toEqual(subtree);
  });

  it("treats a missing old value as added at the root", () => {
    const result = diffJsonValues(undefined, { fresh: true });
    expect(result.added).toHaveLength(1);
    expect(byPath(result.added, "").value).toEqual({ fresh: true });
  });
});

describe("diffJsonValues — removed keys", () => {
  it("reports a top-level removed key", () => {
    const result = diffJsonValues({ a: 1, b: 2 }, { a: 1 });
    expect(byPath(result.removed, "b").value).toBe(2);
  });

  it("reports a nested removed key with the full path", () => {
    const result = diffJsonValues(
      { config: { host: "localhost", port: 8080 } },
      { config: { host: "localhost" } },
    );
    expect(byPath(result.removed, "config.port").value).toBe(8080);
  });

  it("reports a wholly removed subtree as one removed entry", () => {
    const subtree = { items: [1, 2] };
    const result = diffJsonValues({ branch: subtree }, {});
    expect(result.removed).toHaveLength(1);
    expect(byPath(result.removed, "branch").value).toEqual(subtree);
  });

  it("treats a missing new value as removed at the root", () => {
    const result = diffJsonValues({ gone: true }, undefined);
    expect(byPath(result.removed, "").value).toEqual({ gone: true });
  });
});

describe("diffJsonValues — changed values", () => {
  it("reports root primitive changes at the empty path", () => {
    const result = diffJsonValues("old", "new");
    expect(result.changed).toEqual([
      { path: "", oldValue: "old", newValue: "new" },
    ]);
  });

  it("reports a changed primitive with old and new values", () => {
    const result = diffJsonValues({ count: 1 }, { count: 2 });
    const change = byPath(result.changed, "count");
    expect(change.oldValue).toBe(1);
    expect(change.newValue).toBe(2);
  });

  it("reports a nested changed primitive", () => {
    const result = diffJsonValues(
      { meta: { version: 1 } },
      { meta: { version: 2 } },
    );
    const change = byPath(result.changed, "meta.version");
    expect(change.oldValue).toBe(1);
    expect(change.newValue).toBe(2);
  });

  it("does not emit a change when primitives are equal", () => {
    const result = diffJsonValues({ ok: true, n: 0 }, { ok: true, n: 0 });
    expect(result.changed).toHaveLength(0);
  });

  it("distinguishes +0 and -0 as a change", () => {
    const result = diffJsonValues({ n: 0 }, { n: -0 });
    expect(byPath(result.changed, "n").oldValue).toBe(0);
    expect(byPath(result.changed, "n").newValue).toBe(-0);
  });

  it("treats NaN as equal to NaN", () => {
    const result = diffJsonValues({ n: NaN }, { n: NaN });
    expect(result.changed).toHaveLength(0);
  });
});

describe("diffJsonValues — type changes", () => {
  it("reports a primitive -> object swap at the path", () => {
    const result = diffJsonValues({ a: 1 }, { a: { nested: true } });
    const change = byPath(result.changed, "a");
    expect(change.oldValue).toBe(1);
    expect(change.newValue).toEqual({ nested: true });
  });

  it("reports an object -> array swap at the path", () => {
    const result = diffJsonValues({ a: { x: 1 } }, { a: [1] });
    const change = byPath(result.changed, "a");
    expect(change.oldValue).toEqual({ x: 1 });
    expect(change.newValue).toEqual([1]);
  });

  it("reports null -> number as a change", () => {
    const result = diffJsonValues({ v: null }, { v: 3 });
    const change = byPath(result.changed, "v");
    expect(change.oldValue).toBeNull();
    expect(change.newValue).toBe(3);
  });
});

describe("diffJsonValues — arrays", () => {
  it("treats an entire root array as added or removed at the root path", () => {
    expect(diffJsonValues(undefined, [1, 2]).added).toEqual([
      { path: "", value: [1, 2] },
    ]);
    expect(diffJsonValues([1, 2], undefined).removed).toEqual([
      { path: "", value: [1, 2] },
    ]);
  });

  it("reports an appended index as added", () => {
    const result = diffJsonValues([1, 2], [1, 2, 3]);
    expect(byPath(result.added, "2").value).toBe(3);
  });

  it("reports a truncated index as removed", () => {
    const result = diffJsonValues([1, 2, 3], [1, 2]);
    expect(byPath(result.removed, "2").value).toBe(3);
  });

  it("reports an in-place element change by index path", () => {
    const result = diffJsonValues(
      { items: ["a", "b", "c"] },
      { items: ["a", "B", "c"] },
    );
    const change = byPath(result.changed, "items.1");
    expect(change.oldValue).toBe("b");
    expect(change.newValue).toBe("B");
  });

  it("diffs nested objects inside arrays", () => {
    const result = diffJsonValues(
      { rows: [{ id: 1, v: 1 }] },
      { rows: [{ id: 1, v: 2 }] },
    );
    expect(byPath(result.changed, "rows.0.v").newValue).toBe(2);
  });
});

describe("diffJsonValues — mixed nested edits", () => {
  it("reports additions before removals for object key union deterministically", () => {
    const result = diffJsonValues({ z: 1, remove: true }, { a: 2, z: 1 });

    expect(result.added.map((entry) => entry.path)).toEqual(["a"]);
    expect(result.removed.map((entry) => entry.path)).toEqual(["remove"]);
    expect(result.changed).toEqual([]);
  });

  it("isolates changes to only the affected branches", () => {
    const old = {
      keep: { n: 1, deep: { a: 1, b: 2 } },
      drop: true,
      edit: { flag: false },
    };
    const next = {
      keep: { n: 1, deep: { a: 1, b: 99 } },
      edit: { flag: true },
      fresh: "new",
    };
    const result = diffJsonValues(old, next);

    expect(paths(result)).toEqual(
      ["drop", "edit.flag", "fresh", "keep.deep.b"].sort(),
    );
    expect(byPath(result.removed, "drop").value).toBe(true);
    expect(byPath(result.added, "fresh").value).toBe("new");
    expect(byPath(result.changed, "edit.flag").newValue).toBe(true);
    expect(byPath(result.changed, "keep.deep.b").newValue).toBe(99);
  });
});

describe("diffObjects", () => {
  it("is a thin wrapper over diffJsonValues for objects", () => {
    const result = diffObjects({ a: 1 }, { b: 2 });
    expect(byPath(result.removed, "a").value).toBe(1);
    expect(byPath(result.added, "b").value).toBe(2);
  });
});

describe("diffJsonValues — performance characteristics", () => {
  it("handles a wide object in linear time and pinpoints a single change", () => {
    const old: JsonObject = {};
    const next: JsonObject = {};
    for (let i = 0; i < 10_000; i++) {
      old[`k${i}`] = i;
      next[`k${i}`] = i;
    }
    next["k5000"] = -1;

    const t0 = performance.now();
    const result = diffJsonValues(old, next);
    const elapsed = performance.now() - t0;

    expect(result.changed).toHaveLength(1);
    expect(byPath(result.changed, "k5000").newValue).toBe(-1);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    // Sanity bound — should be milliseconds, not seconds, on CI hardware.
    expect(elapsed).toBeLessThan(500);
  });

  it("skips shared subtrees via reference equality (touches only the edited branch)", () => {
    const shared: JsonObject = {};
    for (let i = 0; i < 5_000; i++) shared[`s${i}`] = i;

    const old: JsonObject = { shared, leaf: 1 };
    const next: JsonObject = { shared, leaf: 2 };

    const result = diffJsonValues(old, next);
    expect(result.changed).toHaveLength(1);
    expect(byPath(result.changed, "leaf").newValue).toBe(2);
    expect(paths(result)).toEqual(["leaf"]);
  });
});

describe("isDiffEmpty", () => {
  it("returns false when any category has entries", () => {
    expect(isDiffEmpty(diffJsonValues({ a: 1 }, { a: 2 }))).toBe(false);
    expect(isDiffEmpty(diffJsonValues({}, { a: 1 }))).toBe(false);
    expect(isDiffEmpty(diffJsonValues({ a: 1 }, {}))).toBe(false);
  });
});
