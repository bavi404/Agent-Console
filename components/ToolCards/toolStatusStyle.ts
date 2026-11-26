import type { ToolStatus } from "@/protocol/toolStatus";

/**
 * Presentation for each tool execution status — one source of truth shared by
 * the chat tool card and the timeline row, so both always agree.
 */

/** Status pill (badge) classes. */
export const TOOL_STATUS_BADGE: Record<ToolStatus, string> = {
  queued: "bg-bg-hover text-ink-faint",
  running: "bg-warn/15 text-warn",
  succeeded: "bg-ok/15 text-ok",
  failed: "bg-err/15 text-err",
  cancelled: "bg-bg-hover text-ink-dim line-through",
  denied: "bg-err/15 text-err ring-1 ring-err/40",
};

/** Status dot classes (timeline gutter, in-flight indicator). */
export const TOOL_STATUS_DOT: Record<ToolStatus, string> = {
  queued: "bg-ink-faint",
  running: "bg-warn animate-pulse-dot",
  succeeded: "bg-ok",
  failed: "bg-err",
  cancelled: "bg-ink-faint",
  denied: "bg-err ring-2 ring-err/30",
};

/** Short human label for the status pill. */
export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  denied: "blocked by policy",
};
