"use client";

import { memo, useEffect, useState } from "react";
import { highlightJson, safeStringify } from "@/lib/highlight";
import type { ToolCardStatus } from "@/lib/streaming";

/** Normalized view model shared by the chat transcript and the timeline tree. */
export interface ToolCardView {
  name: string;
  args: unknown;
  status: ToolCardStatus;
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

const STATUS_STYLE: Record<ToolCardStatus, string> = {
  pending: "bg-bg-hover text-ink-faint",
  acknowledged: "bg-accent-soft text-accent",
  running: "bg-warn/15 text-warn",
  completed: "bg-ok/15 text-ok",
  error: "bg-err/15 text-err",
};

/** Statuses for which the tool is still in flight (no result yet). */
const IN_FLIGHT: ReadonlySet<ToolCardStatus> = new Set([
  "pending",
  "acknowledged",
  "running",
]);

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

/**
 * Tool invocation card.
 *
 * React.memo: tool cards are immutable once completed; a streaming token on a
 * sibling message must not re-run Shiki highlighting here.
 */
export const ToolCard = memo(
  function ToolCard({ tool }: { tool: ToolCardView }) {
  const inFlight = IN_FLIGHT.has(tool.status);

  return (
    <div className="rounded-md border border-edge bg-bg-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {inFlight && (
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${tool.status === "running" ? "animate-pulse-dot bg-warn" : "bg-ink-faint"}`}
            />
          )}
          <span className="font-mono text-sm text-ink">{tool.name}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLE[tool.status]}`}
          >
            {tool.status}
          </span>
        </div>
        {tool.durationMs !== undefined && (
          <span className="text-xs text-ink-faint">{tool.durationMs}ms</span>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Arguments
          </div>
          <CodeBlock value={tool.args} />
        </div>

        {tool.status === "error" ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-err">
              Error
            </div>
            <pre className="overflow-x-auto rounded-md border border-err/30 bg-err/5 p-2.5 text-xs text-err">
              {tool.error ?? "Unknown error"}
            </pre>
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
    prev.tool.args === next.tool.args &&
    prev.tool.result === next.tool.result &&
    prev.tool.error === next.tool.error &&
    prev.tool.durationMs === next.tool.durationMs,
);
