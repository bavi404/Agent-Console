/**
 * Fixed reconnect backoff schedule.
 *
 * Attempt 1 waits 500ms, then 1s, 2s, 4s, 8s, capped at 10s for all later
 * attempts. No jitter — delays are predictable and the reconnect indicator can
 * appear immediately while the first attempt is scheduled for 500ms.
 */
export const RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 10_000,
] as const;

/** Delay before reconnect attempt `attempt` (1-based). */
export function reconnectDelayMs(attempt: number): number {
  if (attempt < 1) return RECONNECT_DELAYS_MS[0];
  const index = attempt - 1;
  if (index >= RECONNECT_DELAYS_MS.length) {
    return RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]!;
  }
  return RECONNECT_DELAYS_MS[index]!;
}
