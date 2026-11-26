"use client";

import { memo, useEffect, useState } from "react";
import { highlightJson, safeStringify } from "@/lib/highlight";
import {
  isInFlightToolStatus,
  type ToolStatus,
} from "@/protocol/toolStatus";
import {
  TOOL_STATUS_BADGE,
  TOOL_STATUS_DOT,
  TOOL_STATUS_LABEL,
} from "./toolStatusStyle";

/** Normalized view model shared by the chat transcript and the timeline tree. */
export interface ToolCardView {
  name: string;
  args: unknown;
  status: ToolStatus;
  /** Delivery: TOOL_ACK sent. Omitted where not tracked (timeline). */
  acknowledged?: boolean;
  detail?: string;
  progress?: number;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

function useHighlightedJson(value: unknown): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const serialized = safeStringify(value);
  useEffect(() => {
    let active = true;
    highlightJson(value)
      .then((result) => {
        if (active) setHtml(result);
      })
      .catch(() => {
        if (active) setHtml(null);
      });
    return () => {
      active = false;
    };
    // Re-highlight only when the serialized content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
  return html;
}

/** Shiki highlight is async — memoized so parent re-renders don't restart it. */
const CodeBlock = memo(function CodeBlock({ value }: { value: unknown }) {
  const html = useHighlightedJson(value);
  if (html) {
    return (
      <div
        className="overflow-x-auto rounded-md border border-edge text-xs [&_pre]:m-0 [&_pre]:bg-bg-panel [&_pre]:p-2.5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-edge bg-bg-panel p-2.5 text-xs text-ink-dim">
      {safeStringify(value)}
    </pre>
  );
});

/** Live progress note / bar for an in-flight tool. */
function ToolProgress({
  detail,
  progress,
}: {
  detail: string | undefined;
  progress: number | undefined;
}) {
  return (
    <div className="mb-2 space-y-1">
      {detail !== undefined && (
        <div className="text-xs text-ink-dim">{detail}</div>
      )}
      {progress !== undefined && (
        <div
          className="h-1 overflow-hidden rounded bg-bg-hover"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full bg-warn transition-[width] duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Tool invocation card.
 *
 * React.memo: tool cards are immutable once completed; a streaming token on a
 * sibling message must not re-run Shiki highlighting here.
 */
export const ToolCard = memo(
  function ToolCard({ tool }: { tool: ToolCardView }) {
  const inFlight = isInFlightToolStatus(tool.status);

  return (
    <div className="rounded-md border border-edge bg-bg-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {inFlight && (
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${TOOL_STATUS_DOT[tool.status]}`}
            />
          )}
          <span className="font-mono text-sm text-ink">{tool.name}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${TOOL_STATUS_BADGE[tool.status]}`}
          >
            {TOOL_STATUS_LABEL[tool.status]}
          </span>
          {tool.acknowledged === false && (
            <span
              className="text-[10px] text-ink-faint"
              title="TOOL_ACK not yet sent"
            >
              unacked
            </span>
          )}
        </div>
        {tool.durationMs !== undefined && (
          <span className="text-xs text-ink-faint">{tool.durationMs}ms</span>
        )}
      </div>

      {inFlight && (tool.detail !== undefined || tool.progress !== undefined) && (
        <ToolProgress detail={tool.detail} progress={tool.progress} />
      )}

      <div className="space-y-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Arguments
          </div>
          <CodeBlock value={tool.args} />
        </div>

        {tool.status === "failed" ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-err">
              Error
            </div>
            <pre className="overflow-x-auto rounded-md border border-err/30 bg-err/5 p-2.5 text-xs text-err">
              {tool.error ?? "Unknown error"}
            </pre>
          </div>
        ) : tool.status === "cancelled" ? (
          <div className="text-xs text-ink-dim">
            Cancelled before completion
            {tool.detail !== undefined ? ` — ${tool.detail}` : ""}.
          </div>
        ) : tool.result !== undefined ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
              Result
            </div>
            <CodeBlock value={tool.result} />
          </div>
        ) : null}
      </div>
    </div>
  );
  },
  (prev, next) =>
    prev.tool.name === next.tool.name &&
    prev.tool.status === next.tool.status &&
    prev.tool.acknowledged === next.tool.acknowledged &&
    prev.tool.detail === next.tool.detail &&
    prev.tool.progress === next.tool.progress &&
    prev.tool.args === next.tool.args &&
    prev.tool.result === next.tool.result &&
    prev.tool.error === next.tool.error &&
    prev.tool.durationMs === next.tool.durationMs,
);
