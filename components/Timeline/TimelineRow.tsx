"use client";

import { memo, useCallback } from "react";
import { useTimelineStore } from "@/stores/timelineStore";
import type { ToolPhase } from "@/stores/timelineStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { ToolCard, type ToolCardView } from "@/components/ToolCards/ToolCard";
import type { ToolCardStatus } from "@/lib/streaming";

const PHASE_DOT: Record<ToolPhase, string> = {
  running: "bg-warn animate-pulse-dot",
  completed: "bg-ok",
  error: "bg-err",
};

const PHASE_TO_CARD: Record<ToolPhase, ToolCardStatus> = {
  running: "running",
  completed: "completed",
  error: "error",
};

/**
 * A single timeline row.
 *
 * React.memo: the parent virtualizer may reposition wrappers without this row's
 * data changing; memo blocks redundant reconciliation.
 *
 * Store selectors:
 *   - `items[id]`         — only this row's volatile token count / tool phase.
 *   - `expanded[id]`      — not the whole `expanded` map (other rows toggling
 *                           must not re-render this one).
 *   - `selectedId === id` — not the raw selectedId (selection elsewhere is free).
 */
function TimelineRowImpl({ id }: { id: string }) {
  const item = useTimelineStore((s) => s.items[id]);
  const expanded = useTimelineStore((s) => s.expanded[id] === true);
  const toggleExpanded = useTimelineStore((s) => s.toggleExpanded);
  const selected = useSelectionStore((s) => s.selectedId === id);
  const select = useSelectionStore((s) => s.select);

  const onToggle = useCallback(() => {
    toggleExpanded(id);
  }, [toggleExpanded, id]);

  const onSelect = useCallback(() => {
    select(id);
  }, [select, id]);

  if (!item) return null;

  const canExpand =
    item.kind === "tool" || (item.kind === "message" && item.tokenCount > 0);

  return (
    <div
      className={`rounded-md border px-2 py-1.5 transition-colors ${
        selected
          ? "border-accent bg-accent-soft"
          : "border-transparent hover:bg-bg-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => canExpand && onToggle()}
          className="w-4 shrink-0 text-ink-faint hover:text-ink"
          aria-label={expanded ? "Collapse" : "Expand"}
          disabled={!canExpand}
        >
          {canExpand ? (expanded ? "▾" : "▸") : "·"}
        </button>

        {item.kind === "tool" ? (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${PHASE_DOT[item.phase]}`}
          />
        ) : (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${item.streaming ? "bg-accent animate-pulse-dot" : "bg-ink-faint"}`}
          />
        )}

        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title="Highlight in chat"
        >
          {item.kind === "tool" ? (
            <>
              <span className="truncate font-mono text-sm text-ink">
                {item.name}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                {item.phase}
              </span>
              {item.durationMs !== undefined && (
                <span className="ml-auto shrink-0 text-xs text-ink-faint">
                  {item.durationMs}ms
                </span>
              )}
            </>
          ) : (
            <>
              <span className="truncate text-sm text-ink">
                {item.role === "user" ? "User message" : "Streamed"}{" "}
                {item.role !== "user" && (
                  <span className="text-ink-dim">
                    {item.tokenCount} tokens
                  </span>
                )}
              </span>
              {item.streaming && (
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-warn">
                  streaming
                </span>
              )}
            </>
          )}
        </button>
      </div>

      {expanded && (
        <div className="pl-6 pt-2">
          {item.kind === "tool" ? (
            <ToolCard tool={toCardView(item)} />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim">
              {item.text || "(no content)"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function toCardView(node: {
  name: string;
  args: unknown;
  phase: ToolPhase;
  result?: unknown;
  error?: string;
  durationMs?: number;
}): ToolCardView {
  return {
    name: node.name,
    args: node.args,
    status: PHASE_TO_CARD[node.phase],
    ...(node.result !== undefined ? { result: node.result } : {}),
    ...(node.error !== undefined ? { error: node.error } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
  };
}

export const TimelineRow = memo(TimelineRowImpl);
