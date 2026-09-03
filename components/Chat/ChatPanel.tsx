"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "@/stores/chatStore";
import { TranscriptRow } from "@/components/Chat/TranscriptRow";
import { useSelectionStore } from "@/stores/selectionStore";
import { useWebSocketStore } from "@/stores/websocketStore";
import { DEMO_PROMPT } from "@/lib/demoScenario";

/**
 * Chat transcript with virtualized rows.
 *
 * Rendering performance strategy:
 *   1. Subscribe to `order` only — not token counts — so the virtualizer shell
 *      does not re-render at 30+ TOKEN/s.
 *   2. Auto-scroll pins via a store subscription (imperative DOM), not React state.
 *   3. Each `TranscriptRow` owns a per-id store subscription; only the active
 *      stream row reconciles at token rate. History stays idle.
 *   4. `@tanstack/react-virtual` mounts O(visible) rows, not O(transcript).
 */
export function ChatPanel({ onSend }: { onSend: (text: string) => void }) {
  const order = useChatStore((s) => s.order);
  const selectedId = useSelectionStore((s) => s.selectedId);
  const connection = useWebSocketStore((s) => s.connection);
  const demoReady =
    connection === "Connected" ||
    connection === "Streaming" ||
    connection === "ToolCallPending";

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const prefilled = useRef(false);

  // Prefill the scripted question once connected — press Enter on camera, no demo chrome.
  useEffect(() => {
    if (!demoReady || prefilled.current) return;
    prefilled.current = true;
    setDraft(DEMO_PROMPT);
  }, [demoReady]);

  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => order[i] ?? i,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Pin to bottom on new transcript rows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [order.length]);

  // Pin to bottom while tokens arrive — imperative, no panel re-render.
  useEffect(() => {
    const pin = () => {
      const el = scrollRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };

    return useChatStore.subscribe((state, prev) => {
      const id = state.activeStreamId;
      if (!id) return;
      const item = state.items[id];
      if (item?.kind !== "message") return;
      const prevItem = prev.items[id];
      const prevCount =
        prevItem?.kind === "message" ? prevItem.tokenCount : -1;
      if (item.tokenCount !== prevCount) pin();
    });
  }, []);

  // Timeline -> chat: scroll when the target appears in the transcript.
  useEffect(() => {
    if (!selectedId) return;
    const idx = order.indexOf(selectedId);
    if (idx === -1) return;
    virtualizerRef.current.scrollToIndex(idx, { align: "center" });
  }, [selectedId, order]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {order.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {connection === "Connecting" || connection === "Disconnected"
              ? "Connecting to agent…"
              : "No messages yet."}
          </p>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vr) => {
              const id = order[vr.index];
              if (id === undefined) return null;
              return (
                <div
                  key={id}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vr.start}px)`,
                  }}
                  className="pb-4"
                >
                  <TranscriptRow id={id} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-edge p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Message the agent…"
            className="max-h-32 flex-1 resize-none rounded-md border border-edge bg-bg-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
