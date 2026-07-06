/**
 * Recursive JSON diff for the Context Inspector.
 *
 * Pure and framework-free so it can run on the main thread or inside a Web
 * Worker (large snapshots are diffed off-thread to avoid blocking the UI).
 *
 * `diffJson` builds a `DiffNode` tree that mirrors the merged shape of the two
 * snapshots, tagging every node added / removed / changed / unchanged. A
 * container is "changed" iff any descendant differs (computed bottom-up).
 *
 * Rendering stays cheap on huge payloads because `flattenDiff` is lazy — it
 * only walks nodes whose ancestors are expanded — and the panel virtualizes
 * the resulting rows.
 */
import type { JsonValue } from "@/protocol/types";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";
export type ValueKind = "object" | "array" | "primitive";

export interface DiffNode {
  /** Property name, array index (as string), or "$" for the root. */
  key: string;
  /** Stable unique id for expansion/selection. */
  path: string;
  status: DiffStatus;
  kind: ValueKind;
  /** Display value for primitives (current, or previous when removed). */
  value: JsonValue;
  /** Previous value for a changed primitive. */
  prevValue?: JsonValue;
  /** Present for containers (object/array). */
  children?: DiffNode[];
}

// Unlikely-in-keys separator keeps paths unique without per-node encoding cost.
const SEP = "\u0001";

function kindOf(value: JsonValue): ValueKind {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "primitive";
}

/** Build a uniform-status node tree from a single side (added or removed). */
function buildSide(
  value: JsonValue,
  status: DiffStatus,
  key: string,
  path: string,
): DiffNode {
  const kind = kindOf(value);
  if (kind === "primitive") {
    return { key, path, status, kind, value };
  }
  const children: DiffNode[] = [];
  if (kind === "array") {
    const arr = value as JsonValue[];
    for (let i = 0; i < arr.length; i++) {
      const k = String(i);
      children.push(buildSide(arr[i] as JsonValue, status, k, path + SEP + k));
    }
  } else {
    const obj = value as { [k: string]: JsonValue };
    for (const k of Object.keys(obj)) {
      children.push(buildSide(obj[k] as JsonValue, status, k, path + SEP + k));
    }
  }
  return { key, path, status, kind, value: null, children };
}

function diffNode(
  prev: JsonValue | undefined,
  next: JsonValue | undefined,
  key: string,
  path: string,
): DiffNode {
  if (prev === undefined) return buildSide(next as JsonValue, "added", key, path);
  if (next === undefined) return buildSide(prev, "removed", key, path);
  // Identical reference: whole subtree is unchanged (cheap fast-path).
  if (prev === next) return buildSide(next, "unchanged", key, path);

  const pk = kindOf(prev);
  const nk = kindOf(next);

  if (pk !== nk) {
    // Type was replaced — show the new shape, flagged as changed.
    const node = buildSide(next, "changed", key, path);
    if (node.kind === "primitive") node.prevValue = prev;
    return node;
  }

  if (nk === "primitive") {
    return Object.is(prev, next)
      ? { key, path, status: "unchanged", kind: "primitive", value: next }
      : {
          key,
          path,
          status: "changed",
          kind: "primitive",
          value: next,
          prevValue: prev,
        };
  }

  const children: DiffNode[] = [];
  let anyChanged = false;

  if (nk === "array") {
    const pa = prev as JsonValue[];
    const na = next as JsonValue[];
    const len = Math.max(pa.length, na.length);
    for (let i = 0; i < len; i++) {
      const k = String(i);
      const child = diffNode(
        i < pa.length ? pa[i] : undefined,
        i < na.length ? na[i] : undefined,
        k,
        path + SEP + k,
      );
      if (child.status !== "unchanged") anyChanged = true;
      children.push(child);
    }
  } else {
    const po = prev as { [k: string]: JsonValue };
    const no = next as { [k: string]: JsonValue };
    const seen = new Set<string>();
    for (const k of Object.keys(no)) {
      seen.add(k);
      const child = diffNode(
        k in po ? po[k] : undefined,
        no[k],
        k,
        path + SEP + k,
      );
      if (child.status !== "unchanged") anyChanged = true;
      children.push(child);
    }
    for (const k of Object.keys(po)) {
      if (seen.has(k)) continue;
      children.push(diffNode(po[k], undefined, k, path + SEP + k));
      anyChanged = true;
    }
  }

  return {
    key,
    path,
    status: anyChanged ? "changed" : "unchanged",
    kind: nk,
    value: null,
    children,
  };
}

/**
 * Diff two snapshots. Pass the same value for both (or use `treeOf`) when there
 * is no baseline — everything reads as unchanged.
 */
export function diffJson(
  prev: JsonValue | undefined,
  next: JsonValue | undefined,
): DiffNode {
  return diffNode(prev, next, "$", "$");
}

/** A plain, all-unchanged tree (used when there is no baseline to compare). */
export function treeOf(next: JsonValue): DiffNode {
  return buildSide(next, "unchanged", "$", "$");
}

export interface DiffRow {
  node: DiffNode;
  depth: number;
  expanded: boolean;
}

/**
 * Lazily flatten the diff into visible rows. Collapsed subtrees are skipped
 * entirely, so this is O(visible rows) regardless of total payload size.
 * The root is hidden — its children render at depth 0.
 */
export function flattenDiff(
  root: DiffNode,
  expanded: ReadonlySet<string>,
): DiffRow[] {
  const out: DiffRow[] = [];
  const visit = (node: DiffNode, depth: number): void => {
    const hasChildren = node.children !== undefined && node.children.length > 0;
    const isExpanded = hasChildren && expanded.has(node.path);
    out.push({ node, depth, expanded: isExpanded });
    if (isExpanded && node.children) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  if (root.children) {
    for (const child of root.children) visit(child, 0);
  } else {
    out.push({ node: root, depth: 0, expanded: false });
  }
  return out;
}

/**
 * Paths to expand by default: the chains of "changed" containers, so the diffs
 * are revealed without opening unchanged or wholly added/removed subtrees.
 * Bounded so a pathological payload can't create an enormous initial render.
 */
export function autoExpandPaths(root: DiffNode, limit = 200): Set<string> {
  const set = new Set<string>();
  const queue: DiffNode[] = root.children ? [...root.children] : [];
  while (queue.length > 0 && set.size < limit) {
    const node = queue.shift() as DiffNode;
    if (
      node.status === "changed" &&
      node.children !== undefined &&
      node.children.length > 0
    ) {
      set.add(node.path);
      for (const child of node.children) queue.push(child);
    }
  }
  return set;
}
