import type { ApprovalOutcome, ToolStatus } from "@/protocol/toolStatus";

/**
 * Presentation for each tool execution status — one source of truth shared by
 * the chat tool card and the timeline row, so both always agree.
 */

/** Status pill (badge) classes. */
export const TOOL_STATUS_BADGE: Record<ToolStatus, string> = {
  queued: "bg-bg-hover text-ink-faint",
  awaiting_approval: "bg-accent-soft text-accent ring-1 ring-accent/50",
  running: "bg-warn/15 text-warn",
  succeeded: "bg-ok/15 text-ok",
  failed: "bg-err/15 text-err",
  cancelled: "bg-bg-hover text-ink-dim line-through",
  denied: "bg-err/15 text-err ring-1 ring-err/40",
  rejected: "bg-err/15 text-err",
};

/** Status dot classes (timeline gutter, in-flight indicator). */
export const TOOL_STATUS_DOT: Record<ToolStatus, string> = {
  queued: "bg-ink-faint",
  awaiting_approval: "bg-accent animate-pulse-dot ring-2 ring-accent/30",
  running: "bg-warn animate-pulse-dot",
  succeeded: "bg-ok",
  failed: "bg-err",
  cancelled: "bg-ink-faint",
  denied: "bg-err ring-2 ring-err/30",
  rejected: "bg-err",
};

/** Short human label for the status pill. */
export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  queued: "queued",
  awaiting_approval: "needs approval",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  denied: "blocked by policy",
  rejected: "rejected",
};

/** Provenance chip shown once an approval request has been resolved. */
export const APPROVAL_CHIP: Record<
  ApprovalOutcome,
  { label: string; className: string }
> = {
  approved: { label: "✓ approved", className: "text-ok" },
  rejected: { label: "✕ rejected by user", className: "text-err" },
  expired: { label: "⌛ approval expired", className: "text-ink-dim" },
};
