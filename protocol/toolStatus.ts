/**
 * Tool execution status — the lifecycle vocabulary shared by the wire protocol,
 * the transcript reducer, and the timeline.
 *
 * Pure TypeScript (no React / Zustand), like everything in protocol/.
 *
 *   queued ──▶ running ──▶ succeeded
 *      │          │    └──▶ failed
 *      └──────────┴───────▶ cancelled
 *
 * Status is owned by the server: the client never invents "running". The
 * lifecycle is monotonic — a status may only move forward, and a terminal status
 * is final — so replayed or late frames can never regress a tool card.
 */

export const TOOL_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

const TOOL_STATUS_SET: ReadonlySet<string> = new Set(TOOL_STATUSES);

/** Lifecycle rank: higher ranks may follow lower ones, never the reverse. */
const RANK: Record<ToolStatus, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  cancelled: 2,
};

/** Narrow an unknown value (e.g. straight off the wire) to a ToolStatus. */
export function isToolStatus(value: unknown): value is ToolStatus {
  return typeof value === "string" && TOOL_STATUS_SET.has(value);
}

/** Terminal statuses end the lifecycle; no further transitions are accepted. */
export function isTerminalToolStatus(status: ToolStatus): boolean {
  return RANK[status] === RANK.succeeded;
}

/** In flight = announced but not yet finished. */
export function isInFlightToolStatus(status: ToolStatus): boolean {
  return !isTerminalToolStatus(status);
}

/**
 * May a tool move from `from` to `to`? Only strictly forward moves are legal,
 * so terminal statuses are final and a duplicate status is a no-op.
 */
export function canAdvanceToolStatus(
  from: ToolStatus,
  to: ToolStatus,
): boolean {
  return RANK[to] > RANK[from];
}

/** The terminal status implied by a TOOL_RESULT's `ok` flag. */
export function toolStatusFromResult(ok: boolean): ToolStatus {
  return ok ? "succeeded" : "failed";
}

/** Clamp an optional progress fraction into [0, 1]; drop non-finite values. */
export function normalizeProgress(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** The status-bearing fields shared by every tool view model. */
export interface ToolStatusFields {
  status: ToolStatus;
  detail?: string;
  progress?: number;
}

/**
 * Does `update` change a tool currently at `current`?
 *   - a forward status move, or
 *   - a progress tick: same in-flight status with a new detail / progress.
 * Regressions, post-terminal updates, and exact duplicates are rejected.
 */
export function shouldApplyToolStatus(
  current: ToolStatusFields,
  update: ToolStatusFields,
): boolean {
  if (canAdvanceToolStatus(current.status, update.status)) return true;
  return (
    update.status === current.status &&
    isInFlightToolStatus(current.status) &&
    (update.detail !== current.detail ||
      normalizeProgress(update.progress) !== current.progress)
  );
}

/**
 * Return a copy of `node` carrying `update`'s status, detail and progress.
 * Detail/progress absent from the update are cleared so stale notes never
 * outlive the status they described. Progress is normalized to [0, 1].
 */
export function mergeToolStatus<T extends ToolStatusFields>(
  node: T,
  update: ToolStatusFields,
): T {
  const merged: T = { ...node, status: update.status };
  delete merged.detail;
  delete merged.progress;
  const progress = normalizeProgress(update.progress);
  if (update.detail !== undefined) merged.detail = update.detail;
  if (progress !== undefined) merged.progress = progress;
  return merged;
}
