import { create } from "zustand";
import type { ChatRole } from "@/protocol/types";

/**
 * Agent trace timeline store.
 *
 * Two node kinds live in one ordered list:
 *   - message: a batched view of a token stream ("Streamed 42 tokens").
 *   - tool:    a tool call linked to its result by callId (one node, updated
 *              in place from running -> completed/error).
 *
 * Performance contract — the timeline must not re-render the whole list when
 * tokens arrive. We split state into:
 *   - `items`  : volatile node data (token counts, text, tool phase). Mutated
 *                frequently; subscribed to per-row so only the changed row
 *                re-renders.
 *   - `order`/`index`: structural data (which rows exist, their searchable
 *                text). Mutated rarely (node creation, stream end). The panel
 *                subscribes to these, so token syncs never invalidate it.
 */

export type ToolPhase = "running" | "completed" | "error";
export type TraceKind = "message" | "tool";

export interface MessageNode {
  id: string; // messageId / stream_id
  kind: "message";
  role: ChatRole;
  seq: number;
  tokenCount: number;
  text: string;
  streaming: boolean;
}

export interface ToolNode {
  id: string; // callId
  kind: "tool";
  seq: number;
  name: string;
  args: unknown;
  phase: ToolPhase;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export type TraceItem = MessageNode | ToolNode;

/** Structural, search-only projection (excludes volatile token counts). */
export interface TraceIndexEntry {
  kind: TraceKind;
  text: string; // lowercased searchable text
}

export type TraceFilter = "all" | "message" | "tool";

function searchSnippet(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? "";
  } catch {
    return "";
  }
}

interface TimelineState {
  order: string[];
  items: Record<string, TraceItem>;
  index: Record<string, TraceIndexEntry>;
  expanded: Record<string, boolean>;
  query: string;
  filter: TraceFilter;

  /** Create a message node on first token (structural, idempotent). */
  ensureMessage: (input: { id: string; role: ChatRole; seq: number }) => void;
  /** Update the volatile token count/text of an existing message node. */
  syncMessage: (input: {
    id: string;
    tokenCount: number;
    text: string;
    streaming: boolean;
  }) => void;
  /** Finalize a message: stop streaming and fold its text into the index. */
  endMessage: (id: string) => void;
  /** Stop streaming without requiring STREAM_END (e.g. server ERROR). */
  failMessage: (id: string) => void;

  applyToolCall: (input: {
    callId: string;
    name: string;
    args: unknown;
    seq: number;
  }) => void;
  applyToolResult: (input: {
    callId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }) => void;

  toggleExpanded: (id: string) => void;
  setQuery: (query: string) => void;
  setFilter: (filter: TraceFilter) => void;
  reset: () => void;
}

const initial = {
  order: [] as string[],
  items: {} as Record<string, TraceItem>,
  index: {} as Record<string, TraceIndexEntry>,
  expanded: {} as Record<string, boolean>,
  query: "",
  filter: "all" as TraceFilter,
};

export const useTimelineStore = create<TimelineState>((set) => ({
  ...initial,

  ensureMessage: ({ id, role, seq }) =>
    set((state) => {
      if (state.items[id]) return state; // already exists; nothing structural
      const node: MessageNode = {
        id,
        kind: "message",
        role,
        seq,
        tokenCount: 0,
        text: "",
        streaming: true,
      };
      return {
        order: [...state.order, id],
        items: { ...state.items, [id]: node },
        index: { ...state.index, [id]: { kind: "message", text: `${role} message` } },
      };
    }),

  syncMessage: ({ id, tokenCount, text, streaming }) =>
    set((state) => {
      const node = state.items[id];
      if (!node || node.kind !== "message") return state;
      if (
        node.tokenCount === tokenCount &&
        node.text === text &&
        node.streaming === streaming
      ) {
        return state; // no change -> no re-render
      }
      // Only `items` changes here: the panel (order/index) stays referentially
      // stable, so the list does not re-render — just the affected row.
      return {
        items: {
          ...state.items,
          [id]: { ...node, tokenCount, text, streaming },
        },
      };
    }),

  endMessage: (id) =>
    set((state) => {
      const node = state.items[id];
      if (!node || node.kind !== "message") return state;
      return {
        items: { ...state.items, [id]: { ...node, streaming: false } },
        index: {
          ...state.index,
          [id]: {
            kind: "message",
            text: `${node.role} message ${node.text}`.toLowerCase(),
          },
        },
      };
    }),

  failMessage: (id) =>
    set((state) => {
      const node = state.items[id];
      if (!node || node.kind !== "message" || !node.streaming) return state;
      return {
        items: { ...state.items, [id]: { ...node, streaming: false } },
      };
    }),

  applyToolCall: ({ callId, name, args, seq }) =>
    set((state) => {
      if (state.items[callId]) return state; // link target already exists
      const node: ToolNode = {
        id: callId,
        kind: "tool",
        seq,
        name,
        args,
        phase: "running",
      };
      return {
        order: [...state.order, callId],
        items: { ...state.items, [callId]: node },
        index: {
          ...state.index,
          [callId]: {
            kind: "tool",
            text: `${name} ${searchSnippet(args)}`.toLowerCase(),
          },
        },
      };
    }),

  applyToolResult: ({ callId, ok, result, error, durationMs }) =>
    set((state) => {
      const node = state.items[callId];
      if (!node || node.kind !== "tool") return state;
      const updated: ToolNode = {
        ...node,
        phase: ok ? "completed" : "error",
        result,
        ...(error !== undefined ? { error } : {}),
        durationMs,
      };
      return {
        items: { ...state.items, [callId]: updated },
        index: {
          ...state.index,
          [callId]: {
            kind: "tool",
            text:
              `${node.name} ${searchSnippet(node.args)} ${searchSnippet(ok ? result : error)}`.toLowerCase(),
          },
        },
      };
    }),

  toggleExpanded: (id) =>
    set((state) => ({
      expanded: { ...state.expanded, [id]: !state.expanded[id] },
    })),

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  reset: () => set({ ...initial }),
}));
