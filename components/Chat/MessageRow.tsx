"use client";

import { memo } from "react";
import type { ChatMessage, StreamStatus } from "@/stores/chatStore";

/** Role chip — memoized because role never changes after mount. */
const RoleBadge = memo(function RoleBadge({
  role,
}: {
  role: ChatMessage["role"];
}) {
  const styles: Record<ChatMessage["role"], string> = {
    user: "bg-accent-soft text-accent",
    assistant: "bg-bg-raised text-ink-dim",
    system: "bg-bg-hover text-ink-faint",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[role]}`}
    >
      {role}
    </span>
  );
});

/**
 * Trailing cursor for the active stream only.
 * Isolated so completed messages never pay for cursor reconciliation.
 */
const StreamCursor = memo(function StreamCursor({
  status,
}: {
  status: StreamStatus;
}) {
  if (status === "streaming") {
    return (
      <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse-dot bg-accent align-middle" />
    );
  }
  if (status === "paused") {
    return (
      <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-[11px] text-warn">
        <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-warn" />
        waiting on tool…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="ml-1.5 align-middle text-[11px] text-err">
        stream error
      </span>
    );
  }
  return null;
});

/**
 * One chat message row.
 *
 * React.memo with a field-wise compare ensures **completed** messages in the
 * token history never re-render when a *different* stream receives tokens —
 * only `text` / `status` / `tokenCount` changes on this message trigger paint.
 */
export const MessageRow = memo(
  function MessageRow({ message }: { message: ChatMessage }) {
    return (
      <div className="flex flex-col gap-1.5">
        <RoleBadge role={message.role} />
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
          {message.text}
          <StreamCursor status={message.status} />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.text === next.message.text &&
    prev.message.status === next.message.status &&
    prev.message.role === next.message.role &&
    prev.message.tokenCount === next.message.tokenCount,
);
