"use client";

import { memo, useCallback } from "react";
import { useTimelineStore } from "@/stores/timelineStore";
import type { ToolNode } from "@/stores/timelineStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { ToolCard, type ToolCardView } from "@/components/ToolCards/ToolCard";
import {
  TOOL_STATUS_DOT,
  TOOL_STATUS_LABEL,
} from "@/components/ToolCards/toolStatusStyle";

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
            className={`h-2 w-2 shrink-0 rounded-full ${TOOL_STATUS_DOT[item.status]}`}
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
                {TOOL_STATUS_LABEL[item.status]}
              </span>
              {item.detail !== undefined && item.durationMs === undefined && (
                <span className="truncate text-xs text-ink-dim">
                  {item.detail}
                </span>
              )}
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

function toCardView(node: ToolNode): ToolCardView {
  // Everything but the timeline-only fields (kind, id, seq).
  const { kind: _kind, id, seq: _seq, ...view } = node;
  void _kind;
  void _seq;
  return { ...view, callId: id };
}

export const TimelineRow = memo(TimelineRowImpl);
