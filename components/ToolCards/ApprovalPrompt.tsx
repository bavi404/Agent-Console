"use client";

import { useState } from "react";
import { useApprovalStore } from "@/stores/approvalStore";
import { useCountdown } from "@/hooks/useCountdown";

/**
 * Approve / reject controls for a tool call in status "awaiting_approval".
 *
 * Clicking sends TOOL_APPROVAL; the card keeps showing "needs approval" until
 * the server confirms with TOOL_STATUS. Meanwhile the buttons are disabled and
 * the pending choice is shown (from approvalStore, client intent only).
 */
export function ApprovalPrompt({
  callId,
  reason,
  rule,
  expiresAt,
}: {
  callId: string;
  reason: string | undefined;
  rule: string | undefined;
  expiresAt: number | undefined;
}) {
  const submitted = useApprovalStore((s) => s.submitted[callId]);
  const connected = useApprovalStore((s) => s.transport !== null);
  const decide = useApprovalStore((s) => s.decide);
  const remaining = useCountdown(expiresAt);
  const [note, setNote] = useState("");

  const expired = remaining === 0;
  const disabled = submitted !== undefined || !connected || expired;

  return (
    // Stop clicks from also selecting the surrounding transcript/timeline row.
    <div
      className="mb-2 rounded-md border border-accent/40 bg-accent-soft p-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-accent">
        <span className="flex items-center gap-2">
          Approval required
          {rule !== undefined && (
            <code className="rounded bg-accent/10 px-1 py-0.5 normal-case tracking-normal">
              {rule}
            </code>
          )}
        </span>
        {remaining !== null && (
          <span className="normal-case tracking-normal text-ink-dim">
            {expired ? "expiring…" : `${remaining}s left`}
          </span>
        )}
      </div>
      <p className="mb-2 text-xs text-ink">
        {reason ?? "This tool call needs your approval before it runs."}
      </p>

      {submitted ? (
        <p className="text-xs text-ink-dim" role="status">
          {submitted === "approve" ? "Approval" : "Rejection"} sent — waiting
          for the agent to confirm…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the agent (optional)"
            aria-label="Note for the agent"
            maxLength={280}
            disabled={disabled}
            className="min-w-0 flex-1 rounded border border-edge bg-bg-panel px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => decide(callId, "approve", note)}
            className="rounded bg-ok/20 px-2.5 py-1 text-xs font-medium text-ok hover:bg-ok/30 disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => decide(callId, "reject", note)}
            className="rounded bg-err/15 px-2.5 py-1 text-xs font-medium text-err hover:bg-err/25 disabled:opacity-40"
          >
            Reject
          </button>
          {!connected && (
            <span className="text-[11px] text-ink-faint">
              Reconnect to decide
            </span>
          )}
        </div>
      )}
    </div>
  );
}
