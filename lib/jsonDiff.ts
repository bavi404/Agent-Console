/**
 * Recursive JSON diff engine.
 *
 * Compares two JSON values and returns flat lists of added keys, removed keys,
 * and changed values, each tagged with a nested dot path (`user.address.0.city`).
 *
 * Complexity: O(N) where N is the number of nodes visited across both values.
 * Per object we union keys with a Set (O(1) membership), arrays are walked by
 * index in one pass, and an identical-reference fast path skips whole unchanged
 * subtrees — no pairwise key comparison and no stringify-based equality.
 */
import type { JsonObject, JsonValue } from "@/protocol/types";

export interface AddedEntry {
  /** Nested path; empty string denotes the root value. */
  path: string;
  value: JsonValue;
}

export interface RemovedEntry {
  path: string;
  value: JsonValue;
}

export interface ChangedEntry {
  path: string;
  oldValue: JsonValue;
  newValue: JsonValue;
}

export interface JsonDiffResult {
  added: AddedEntry[];
  removed: RemovedEntry[];
  changed: ChangedEntry[];
}

type ValueKind = "object" | "array" | "primitive";

function kindOf(value: JsonValue): ValueKind {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "primitive";
}

/** Join a parent path with a segment (`""` + `"a"` -> `"a"`, `"a"` + `"b"` -> `"a.b"`). */
export function joinPath(parent: string, segment: string): string {
  return parent === "" ? segment : `${parent}.${segment}`;
}

function emptyResult(): JsonDiffResult {
  return { added: [], removed: [], changed: [] };
}

function unchangedPair(a: JsonValue, b: JsonValue): boolean {
  if (a !== b) return false;
  // `0 === -0` but they are not the same value — recurse for a change entry.
  if (typeof a === "number") return Object.is(a, b);
  return true;
}

function walk(
  oldValue: JsonValue | undefined,
  newValue: JsonValue | undefined,
  path: string,
  out: JsonDiffResult,
): void {
  // Reference equality (or identical primitives): entire subtree unchanged.
  if (
    oldValue !== undefined &&
    newValue !== undefined &&
    unchangedPair(oldValue, newValue)
  ) {
    return;
  }

  if (oldValue === undefined) {
    out.added.push({ path, value: newValue as JsonValue });
    return;
  }
  if (newValue === undefined) {
    out.removed.push({ path, value: oldValue });
    return;
  }

  const oldKind = kindOf(oldValue);
  const newKind = kindOf(newValue);

  if (oldKind !== newKind) {
    out.changed.push({ path, oldValue, newValue });
    return;
  }

  if (oldKind === "primitive") {
    if (!Object.is(oldValue, newValue)) {
      out.changed.push({ path, oldValue, newValue });
    }
    return;
  }

  if (oldKind === "array") {
    const prev = oldValue as JsonValue[];
    const next = newValue as JsonValue[];
    const len = Math.max(prev.length, next.length);
    for (let i = 0; i < len; i++) {
      walk(
        i < prev.length ? prev[i] : undefined,
        i < next.length ? next[i] : undefined,
        joinPath(path, String(i)),
        out,
      );
    }
    return;
  }

  const prev = oldValue as JsonObject;
  const next = newValue as JsonObject;

  // Walk keys present in `next`, then keys only in `prev` — O(|prev| + |next|).
  const seen = new Set<string>();
  for (const key of Object.keys(next)) {
    seen.add(key);
    walk(
      key in prev ? prev[key] : undefined,
      next[key],
      joinPath(path, key),
      out,
    );
  }
  for (const key of Object.keys(prev)) {
    if (seen.has(key)) continue;
    walk(prev[key], undefined, joinPath(path, key), out);
  }
}

/**
 * Diff two JSON values. Either side may be `undefined` (treated as missing).
 *
 * @example
 * diffJsonValues({ a: 1 }, { a: 1, b: 2 })
 * // added: [{ path: "b", value: 2 }]
 */
export function diffJsonValues(
  oldValue: JsonValue | undefined,
  newValue: JsonValue | undefined,
): JsonDiffResult {
  if (oldValue === undefined && newValue === undefined) return emptyResult();
  const out = emptyResult();
  walk(oldValue, newValue, "", out);
  return out;
}

/** Diff two JSON objects (convenience wrapper). */
export function diffObjects(
  oldObject: JsonObject,
  newObject: JsonObject,
): JsonDiffResult {
  return diffJsonValues(oldObject, newObject);
}

/** True when the diff contains no additions, removals, or changes. */
export function isDiffEmpty(result: JsonDiffResult): boolean {
  return (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.changed.length === 0
  );
}
