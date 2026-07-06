"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTimelineStore } from "@/stores/timelineStore";
import type { TraceFilter } from "@/stores/timelineStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useWebSocketStore } from "@/stores/websocketStore";
import { TimelineRow } from "@/components/Timeline/TimelineRow";

const FILTERS: { id: TraceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "message", label: "Messages" },
  { id: "tool", label: "Tools" },
];

const QUERY_DEBOUNCE_MS = 200;

/**
 * Search / filter chrome — presentational; parent owns store subscriptions so
 * keystrokes do not reconcile the virtualized list until the debounced query
 * lands in the store.
 */
const FilterBar = memo(function FilterBar({
  query,
  filter,
  onQueryChange,
  onFilterChange,
}: {
  query: string;
  filter: TraceFilter;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TraceFilter) => void;
}) {
  const [draft, setDraft] = useState(query);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    const handle = window.setTimeout(
      () => onQueryChange(draft),
      QUERY_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [draft, onQueryChange]);

  return (
    <div className="flex items-center gap-2 border-b border-edge p-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search trace…"
        className="min-w-0 flex-1 rounded-md border border-edge bg-bg-raised px-2.5 py-1 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <div className="flex shrink-0 overflow-hidden rounded-md border border-edge">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onFilterChange(f.id)}
            className={`px-2 py-1 text-xs ${
              filter === f.id
                ? "bg-accent text-bg"
                : "bg-bg-raised text-ink-dim hover:bg-bg-hover"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
});

/**
 * Agent trace timeline — optimized for 30+ token syncs/sec.
 */
export function TimelinePanel() {
  const order = useTimelineStore((s) => s.order);
  const index = useTimelineStore((s) => s.index);
  const query = useTimelineStore((s) => s.query);
  const filter = useTimelineStore((s) => s.filter);
  const setQuery = useTimelineStore((s) => s.setQuery);
  const setFilter = useTimelineStore((s) => s.setFilter);
  const connection = useWebSocketStore((s) => s.connection);

  const scrollTarget = useSelectionStore((s) => s.scrollTarget);
  const scrollNonce = useSelectionStore((s) => s.scrollNonce);
  const clearScrollTarget = useSelectionStore((s) => s.clearScrollTarget);

  const visibleIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return order.filter((id) => {
      const entry = index[id];
      if (!entry) return false;
      if (filter !== "all" && entry.kind !== filter) return false;
      if (q && !entry.text.includes(q)) return false;
      return true;
    });
  }, [order, index, query, filter]);

  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: visibleIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 38,
    overscan: 10,
    getItemKey: (i) => visibleIds[i] ?? i,
  });

  useEffect(() => {
    if (stickRef.current && visibleIds.length > 0) {
      virtualizer.scrollToIndex(visibleIds.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds.length]);

  useEffect(() => {
    if (!scrollTarget) return;
    const idx = visibleIds.indexOf(scrollTarget);
    if (idx === -1) {
      if (filter !== "all") setFilter("all");
      if (query) setQuery("");
      return;
    }
    stickRef.current = false;
    virtualizer.scrollToIndex(idx, { align: "center" });
    clearScrollTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget, scrollNonce, visibleIds, query, filter]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="flex h-full flex-col">
      <FilterBar
        query={query}
        filter={filter}
        onQueryChange={setQuery}
        onFilterChange={setFilter}
      />
      <div
        ref={parentRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {visibleIds.length === 0 ? (
          <p className="p-2 text-sm text-ink-faint">
            {order.length === 0
              ? connection === "Connecting" || connection === "Disconnected"
                ? "Waiting for agent activity…"
                : "No timeline activity yet."
              : "No matches."}
          </p>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const id = visibleIds[virtualRow.index];
              if (id === undefined) return null;
              return (
                <div
                  key={id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="pb-1"
                >
                  <TimelineRow id={id} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
