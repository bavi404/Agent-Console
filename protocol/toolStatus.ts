/**
 * Tool execution status — the lifecycle vocabulary shared by the wire protocol,
 * the transcript reducer, and the timeline.
 *
 * Pure TypeScript (no React / Zustand), like everything in protocol/.
 *
 *   queued ──▶ awaiting_approval ──▶ running ──▶ succeeded
 *      │              │                 │    └──▶ failed
 *      │              ├──▶ rejected     │         (a human said no)
 *      ├──────────────┴─────────────────┴──────▶ cancelled
 *      └──────────────────────────────────────▶ denied   (blocked by policy)
 *
 * `awaiting_approval` is optional: calls that need no human sign-off go
 * straight from queued to running.
 *
 * Status is owned by the server: the client never invents "running", and a
 * human decision only takes effect when the server echoes it back. The
 * lifecycle is monotonic — a status may only move forward, and a terminal
 * status is final — so replayed or late frames can never regress a tool card.
 */

export const TOOL_STATUSES = [
  "queued",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
  "rejected",
] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

const TOOL_STATUS_SET: ReadonlySet<string> = new Set(TOOL_STATUSES);

const TERMINAL_RANK = 3;

/** Lifecycle rank: higher ranks may follow lower ones, never the reverse. */
const RANK: Record<ToolStatus, number> = {
  queued: 0,
  awaiting_approval: 1,
  running: 2,
  succeeded: TERMINAL_RANK,
  failed: TERMINAL_RANK,
  cancelled: TERMINAL_RANK,
  denied: TERMINAL_RANK,
  rejected: TERMINAL_RANK,
};

/** Narrow an unknown value (e.g. straight off the wire) to a ToolStatus. */
export function isToolStatus(value: unknown): value is ToolStatus {
  return typeof value === "string" && TOOL_STATUS_SET.has(value);
}

/** Terminal statuses end the lifecycle; no further transitions are accepted. */
export function isTerminalToolStatus(status: ToolStatus): boolean {
  return RANK[status] === TERMINAL_RANK;
}

/**
 * Terminal statuses reached without the tool ever executing ("cancelled",
 * "denied", "rejected"). Such calls have no output, so a later TOOL_RESULT is
 * ignored.
 */
export function isNotExecutedToolStatus(status: ToolStatus): boolean {
  return status === "cancelled" || status === "denied" || status === "rejected";
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

/* ------------------------------- approvals -------------------------------- */

/** How a human-approval request was resolved, as reported by the server. */
export const APPROVAL_OUTCOMES = ["approved", "rejected", "expired"] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

const APPROVAL_OUTCOME_SET: ReadonlySet<string> = new Set(APPROVAL_OUTCOMES);

export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === "string" && APPROVAL_OUTCOME_SET.has(value);
}

/** What the human chose, as sent by the client in TOOL_APPROVAL. */
export const TOOL_DECISIONS = ["approve", "reject"] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

export function isToolDecision(value: unknown): value is ToolDecision {
  return value === "approve" || value === "reject";
}

/* ------------------------------ merge helpers ----------------------------- */

/** The status-bearing fields shared by every tool view model. */
export interface ToolStatusFields {
  status: ToolStatus;
  /** Transient: note describing the current status. */
  detail?: string;
  /** Transient: completion fraction in [0, 1] while running. */
  progress?: number;
  /** Transient: approval deadline (epoch ms) while awaiting_approval. */
  expiresAt?: number;
  /** Sticky: policy rule that denied the call or required approval. */
  policyRule?: string;
  /** Sticky: how the approval request was resolved. */
  approval?: ApprovalOutcome;
}

/**
 * Does `update` change a tool currently at `current`?
 *   - a forward status move, or
 *   - a tick: same in-flight status with a new detail / progress / deadline.
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
      normalizeProgress(update.progress) !== current.progress ||
      update.expiresAt !== current.expiresAt)
  );
}

/**
 * Return a copy of `node` carrying `update`'s status.
 *
 *   - Transient fields (detail, progress, expiresAt) describe the current
 *     status only: they are replaced, and cleared when absent from the update,
 *     so stale notes never outlive the status they described.
 *   - Sticky fields (policyRule, approval) record provenance — which rule asked
 *     for approval, and what the human decided — so they survive later
 *     statuses (e.g. "approved" stays visible after the tool succeeds). They
 *     are only overwritten, never cleared.
 */
export function mergeToolStatus<T extends ToolStatusFields>(
  node: T,
  update: ToolStatusFields,
): T {
  const merged: T = { ...node, status: update.status };
  delete merged.detail;
  delete merged.progress;
  delete merged.expiresAt;
  const progress = normalizeProgress(update.progress);
  if (update.detail !== undefined) merged.detail = update.detail;
  if (progress !== undefined) merged.progress = progress;
  if (update.expiresAt !== undefined) merged.expiresAt = update.expiresAt;
  if (update.policyRule !== undefined) merged.policyRule = update.policyRule;
  if (update.approval !== undefined) merged.approval = update.approval;
  return merged;
}
