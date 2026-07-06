import { describe, it, expect } from "vitest";
import {
  diffJson,
  treeOf,
  flattenDiff,
  autoExpandPaths,
  type DiffNode,
} from "../lib/contextDiff";
import type { JsonValue } from "../protocol/types";

/** Find a direct child by key (avoids coupling tests to the path separator). */
function child(node: DiffNode, key: string): DiffNode {
  const found = node.children?.find((c) => c.key === key);
  if (!found) throw new Error(`no child "${key}"`);
  return found;
}

describe("diffJson — primitives", () => {
  it("flags an unchanged primitive", () => {
    const root = diffJson({ a: 1 }, { a: 1 });
    expect(child(root, "a").status).toBe("unchanged");
    expect(root.status).toBe("unchanged");
  });

  it("flags a changed primitive and keeps the previous value", () => {
    const root = diffJson({ a: 1 }, { a: 2 });
    const a = child(root, "a");
    expect(a.status).toBe("changed");
    expect(a.value).toBe(2);
    expect(a.prevValue).toBe(1);
    expect(root.status).toBe("changed"); // container bubbles up
  });

  it("flags an added key", () => {
    const root = diffJson({ a: 1 }, { a: 1, b: 2 });
    expect(child(root, "b").status).toBe("added");
    expect(child(root, "a").status).toBe("unchanged");
    expect(root.status).toBe("changed");
  });

  it("flags a removed key", () => {
    const root = diffJson({ a: 1, b: 2 }, { a: 1 });
    const b = child(root, "b");
    expect(b.status).toBe("removed");
    expect(b.value).toBe(2); // removed shows the old value
    expect(root.status).toBe("changed");
  });
});

describe("diffJson — type changes", () => {
  it("treats a primitive -> object swap as changed", () => {
    const root = diffJson({ a: 1 }, { a: { x: 1 } });
    const a = child(root, "a");
    expect(a.status).toBe("changed");
    expect(a.kind).toBe("object");
  });

  it("treats an object -> primitive swap as changed and records prevValue", () => {
    const root = diffJson({ a: { x: 1 } }, { a: 5 });
    const a = child(root, "a");
    expect(a.status).toBe("changed");
    expect(a.kind).toBe("primitive");
    expect(a.value).toBe(5);
    expect(a.prevValue).toEqual({ x: 1 });
  });
});

describe("diffJson — nested containers", () => {
  it("bubbles 'changed' up only the affected branch", () => {
    const prev = { keep: { n: 1 }, edit: { n: 1, deep: { v: 1 } } };
    const next = { keep: { n: 1 }, edit: { n: 1, deep: { v: 2 } } };
    const root = diffJson(prev, next);

    expect(child(root, "keep").status).toBe("unchanged");
    const edit = child(root, "edit");
    expect(edit.status).toBe("changed");
    expect(child(edit, "n").status).toBe("unchanged");
    const deep = child(edit, "deep");
    expect(deep.status).toBe("changed");
    expect(child(deep, "v").status).toBe("changed");
  });

  it("uses the identical-reference fast path for unchanged subtrees", () => {
    const shared = { big: { a: 1, b: 2 } };
    const prev: Record<string, JsonValue> = { shared };
    const next: Record<string, JsonValue> = { shared };
    const root = diffJson(prev, next);
    expect(child(root, "shared").status).toBe("unchanged");
  });
});

describe("diffJson — arrays", () => {
  it("diffs by index and marks appended elements added", () => {
    const root = diffJson([1, 2], [1, 2, 3]);
    expect(child(root, "0").status).toBe("unchanged");
    expect(child(root, "1").status).toBe("unchanged");
    expect(child(root, "2").status).toBe("added");
    expect(root.kind).toBe("array");
  });

  it("marks truncated elements removed and changed elements changed", () => {
    const root = diffJson([1, 2, 3], [9, 2]);
    expect(child(root, "0").status).toBe("changed");
    expect(child(root, "1").status).toBe("unchanged");
    expect(child(root, "2").status).toBe("removed");
  });
});

describe("treeOf — no baseline", () => {
  it("produces an all-unchanged tree", () => {
    const root = treeOf({ a: 1, b: { c: 2 } });
    expect(root.status).toBe("unchanged");
    expect(child(root, "a").status).toBe("unchanged");
    expect(child(child(root, "b"), "c").status).toBe("unchanged");
  });
});

describe("flattenDiff — lazy expansion", () => {
  it("hides the root and renders children at depth 0", () => {
    const root = diffJson({ a: 1, b: 2 }, { a: 1, b: 2 });
    const rows = flattenDiff(root, new Set());
    expect(rows.map((r) => r.node.key)).toEqual(["a", "b"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("skips collapsed subtrees entirely (only expanded nodes are walked)", () => {
    const root = diffJson({ obj: { x: 1, y: 2 } }, { obj: { x: 1, y: 3 } });
    const collapsed = flattenDiff(root, new Set());
    expect(collapsed.map((r) => r.node.key)).toEqual(["obj"]); // children not walked

    const obj = child(root, "obj");
    const expanded = flattenDiff(root, new Set([obj.path]));
    expect(expanded.map((r) => r.node.key)).toEqual(["obj", "x", "y"]);
    expect(expanded[1]!.depth).toBe(1);
  });

  it("emits a primitive root as a single row", () => {
    const root = diffJson(1, 2);
    const rows = flattenDiff(root, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.node.status).toBe("changed");
  });
});

describe("autoExpandPaths", () => {
  it("expands the chain of changed containers but not added/unchanged ones", () => {
    const prev = { a: { deep: { v: 1 } }, b: { v: 1 } };
    const next = { a: { deep: { v: 2 } }, b: { v: 1 }, c: { added: 1 } };
    const root = diffJson(prev, next);
    const paths = autoExpandPaths(root);

    const a = child(root, "a");
    const deep = child(a, "deep");
    expect(paths.has(a.path)).toBe(true);
    expect(paths.has(deep.path)).toBe(true);
    // unchanged container is not auto-expanded
    expect(paths.has(child(root, "b").path)).toBe(false);
    // wholly-added container is not auto-expanded (it has status "added")
    expect(paths.has(child(root, "c").path)).toBe(false);
  });

  it("is bounded by the limit", () => {
    const prev: Record<string, JsonValue> = {};
    const next: Record<string, JsonValue> = {};
    for (let i = 0; i < 50; i++) {
      prev[`k${i}`] = { v: 1 };
      next[`k${i}`] = { v: 2 };
    }
    const root = diffJson(prev, next);
    expect(autoExpandPaths(root, 10).size).toBe(10);
  });
});

describe("diffJson — large payload", () => {
  it("handles a wide object and pinpoints the single change", () => {
    const prev: Record<string, JsonValue> = {};
    const next: Record<string, JsonValue> = {};
    for (let i = 0; i < 5000; i++) {
      prev[`k${i}`] = i;
      next[`k${i}`] = i;
    }
    next["k2500"] = -1;

    const root = diffJson(prev, next);
    expect(root.status).toBe("changed");
    expect(child(root, "k2500").status).toBe("changed");
    expect(child(root, "k0").status).toBe("unchanged");

    // Collapsed flatten is O(top-level children), not the whole payload depth.
    const rows = flattenDiff(root, new Set());
    expect(rows).toHaveLength(5000);
  });
});
