"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import type { WsState } from "@/protocol/stateMachine";
import { useWebSocketStore } from "@/stores/websocketStore";

const META: Record<WsState, { label: string; dot: string; pulse: boolean }> = {
  Disconnected: { label: "Disconnected", dot: "bg-ink-faint", pulse: false },
  Connecting: { label: "Connecting", dot: "bg-warn", pulse: true },
  Connected: { label: "Connected", dot: "bg-ok", pulse: false },
  Streaming: { label: "Streaming", dot: "bg-accent", pulse: true },
  ToolCallPending: { label: "Tool call", dot: "bg-accent", pulse: true },
  Reconnecting: { label: "Reconnecting", dot: "bg-warn", pulse: true },
  Resuming: { label: "Resuming", dot: "bg-warn", pulse: true },
  Error: { label: "Error", dot: "bg-err", pulse: false },
};

/**
 * Connection chrome — memoized so chat/timeline token reconciliation (30+/sec)
 * does not repaint the header on every stream tick.
 */
export const ConnectionStatus = memo(function ConnectionStatus({
  onRetry,
}: {
  onRetry?: () => void;
}) {
  const connection = useWebSocketStore((s) => s.connection);
  const attempt = useWebSocketStore((s) => s.attempt);
  const retryInMs = useWebSocketStore((s) => s.retryInMs);
  const delivered = useWebSocketStore((s) => s.messagesDelivered);
  const skips = useWebSocketStore((s) => s.skips);
  const parseErrors = useWebSocketStore((s) => s.parseErrors);
  const currentSeq = useWebSocketStore((s) => s.currentSeq);

  const meta = META[connection];
  const showRetry =
    connection === "Reconnecting" ||
    connection === "Error" ||
    connection === "Disconnected";

  const showReconnectBanner =
    connection === "Reconnecting" || connection === "Resuming";

  return (
    <div className="flex items-center gap-4 text-xs text-ink-dim">
      {showReconnectBanner && (
        <span
          className="flex items-center gap-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-0.5 font-medium text-warn"
          title="Connection lost — state is preserved while reconnecting"
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-warn" />
          Reconnecting
          {attempt > 0 && ` · attempt ${attempt}`}
          {retryInMs !== null && ` · next in ${(retryInMs / 1000).toFixed(1)}s`}
        </span>
      )}
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          {meta.pulse && (
            <motion.span
              className={`absolute inline-flex h-full w-full rounded-full ${meta.dot} opacity-60`}
              animate={{ scale: [1, 2], opacity: [0.6, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${meta.dot}`}
          />
        </span>
        <span className="font-medium text-ink">{meta.label}</span>
        {attempt > 0 && connection !== "Connected" && (
          <span className="text-ink-faint">· attempt {attempt}</span>
        )}
        {retryInMs !== null && (
          <span className="text-ink-faint">
            · retry in {(retryInMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      <span
        className="rounded border border-edge bg-bg-raised px-2 py-0.5 font-mono text-ink-dim"
        title="Current in-order sequence number"
      >
        seq #{currentSeq}
      </span>
      <span className="text-ink-faint">{delivered} events</span>
      {skips.length > 0 && (
        <span
          className="text-warn"
          title="Sequence gaps detected — reconnecting to recover via RESUME"
        >
          {skips.length} seq gap{skips.length === 1 ? "" : "s"}
        </span>
      )}
      {parseErrors > 0 && (
        <span className="text-err">{parseErrors} parse errors</span>
      )}

      {showRetry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-edge px-2 py-0.5 text-ink hover:bg-bg-hover"
        >
          Retry now
        </button>
      )}
    </div>
  );
});
