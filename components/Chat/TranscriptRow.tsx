"use client";

import { memo } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { MessageRow } from "@/components/Chat/MessageRow";
import { ToolCard } from "@/components/ToolCards/ToolCard";

/**
 * One transcript entry (message or tool card).
 *
 * Performance contract:
 *   - Subscribes to `items[id]` only, not the full `items` map.
 *   - When token N arrives on stream A, rows for streams B…Z keep the same
 *     props and React.memo skips them — token history does not re-render.
 *   - Selection is scoped to `selectedId === id` so highlighting one row does
 *     not re-render every other row.
 */
function TranscriptRowImpl({ id }: { id: string }) {
  const item = useChatStore((s) => s.items[id]);
  const isSelected = useSelectionStore((s) => s.selectedId === id);
  const focus = useSelectionStore((s) => s.focus);

  if (!item) return null;

  return (
    <div
      onClick={() => focus(id)}
      className={`cursor-pointer rounded-md px-1 py-1 transition-colors ${
        isSelected ? "bg-accent-soft ring-1 ring-accent" : ""
      }`}
    >
      {item.kind === "message" ? (
        <MessageRow message={item} />
      ) : (
        <ToolCard tool={{ ...item, callId: item.id }} />
      )}
    </div>
  );
}

export const TranscriptRow = memo(TranscriptRowImpl);
