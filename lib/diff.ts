/**
 * Minimal line diff (LCS based).
 *
 * Used to render incremental changes — e.g. when a context value or a tool
 * result is replaced, we show what actually changed rather than reflowing the
 * whole block. Pure and allocation-light for the sizes we deal with.
 */

export type DiffOp =
  | { type: "eq"; value: string }
  | { type: "add"; value: string }
  | { type: "del"; value: string };

/** Length of the shared leading run of characters (cheap streaming helper). */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/** Length of the shared trailing run, not overlapping the prefix. */
export function commonSuffixLength(a: string, b: string, prefix = 0): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * Diff two texts line-by-line via the classic LCS dynamic program.
 * Returns ops in order; equal lines anchor the result.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", value: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", value: a[i]! });
      i += 1;
    } else {
      ops.push({ type: "add", value: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", value: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", value: b[j]! });
    j += 1;
  }
  return ops;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(ops: DiffOp[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added += 1;
    else if (op.type === "del") removed += 1;
  }
  return { added, removed };
}
