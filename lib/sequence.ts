/**
 * Pure helpers for reasoning about monotonic sequence numbers.
 *
 * Kept tiny and dependency-free so both protocol/ and tests can use it.
 */

/** Is `seq` exactly the message we expect after `last`? */
export function isNext(last: number, seq: number): boolean {
  return seq === last + 1;
}

/** Has this sequence number already been consumed? */
export function isStale(last: number, seq: number): boolean {
  return seq <= last;
}

/** Is this sequence ahead of what we can deliver yet (a gap exists)? */
export function isAhead(last: number, seq: number): boolean {
  return seq > last + 1;
}

/**
 * The list of sequence numbers missing between `last` (exclusive) and
 * `seq` (exclusive). Returns [] when there is no gap.
 */
export function gapBetween(last: number, seq: number): number[] {
  if (seq <= last + 1) return [];
  const missing: number[] = [];
  for (let n = last + 1; n < seq; n += 1) missing.push(n);
  return missing;
}
