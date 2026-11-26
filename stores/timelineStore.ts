import { create } from "zustand";
import type { ChatRole } from "@/protocol/types";
import {
  isInFlightToolStatus,
  mergeToolStatus,
  shouldApplyToolStatus,
  toolStatusFromResult,
  type ToolStatus,
} from "@/protocol/toolStatus";

/**
 * Agent trace timeline store.
 *
 * Two node kinds live in one ordered list:
 *   - message: a batched view of a token stream ("Streamed 42 tokens").
 *   - tool:    a tool call keyed by callId (one node, updated in place as the
 *              server reports queued -> running -> succeeded/failed/cancelled).
 *
 * Performance contract — the timeline must not re-render the whole list when
 * tokens arrive. We split state into:
 *   - `items`  : volatile node data (token counts, text, tool status). Mutated
 *                frequently; subscribed to per-row so only the changed row
 *                re-renders.
 *   - `order`/`index`: structural data (which rows exist, their searchable
 *                text). Mutated rarely (node creation, stream end). The panel
 *                subscribes to these, so token syncs never invalidate it.
 */

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
  status: ToolStatus;
  detail?: string;
  progress?: number;
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

/** Searchable text for a tool node: name, status, args, and outcome. */
function toolIndexText(node: ToolNode): string {
  const outcome =
    node.status === "failed"
      ? searchSnippet(node.error)
      : node.result !== undefined
        ? searchSnippet(node.result)
        : "";
  return `${node.name} ${node.status} ${searchSnippet(node.args)} ${outcome}`
    .trim()
    .toLowerCase();
}

/** Insert a new tool node (structural: order + index change). */
function withToolNode(
  state: TimelineState,
  node: ToolNode,
): Partial<TimelineState> {
  return {
    order: [...state.order, node.id],
    items: { ...state.items, [node.id]: node },
    index: { ...state.index, [node.id]: { kind: "tool", text: toolIndexText(node) } },
  };
}

/** Replace an existing tool node; the index is refreshed only on status change. */
function replaceToolNode(
  state: TimelineState,
  prev: ToolNode,
  node: ToolNode,
): Partial<TimelineState> {
  const items = { ...state.items, [node.id]: node };
  if (prev.status === node.status && prev.result === node.result) {
    return { items }; // progress tick: keep the panel referentially stable
  }
  return {
    items,
    index: { ...state.index, [node.id]: { kind: "tool", text: toolIndexText(node) } },
  };
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
  applyToolStatus: (input: {
    callId: string;
    name: string;
    args: unknown;
    status: ToolStatus;
    detail?: string;
    progress?: number;
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
      return withToolNode(state, {
        id: callId,
        kind: "tool",
        seq,
        name,
        args,
        status: "queued",
      });
    }),

  applyToolStatus: (input) =>
    set((state) => {
      const node = state.items[input.callId];
      if (!node) {
        const created: ToolNode = {
          id: input.callId,
          kind: "tool",
          seq: input.seq,
          name: input.name,
          args: input.args,
          status: input.status,
        };
        return withToolNode(state, mergeToolStatus(created, input));
      }
      if (node.kind !== "tool" || !shouldApplyToolStatus(node, input)) {
        return state;
      }
      return replaceToolNode(state, node, mergeToolStatus(node, input));
    }),

  applyToolResult: ({ callId, ok, result, error, durationMs }) =>
    set((state) => {
      const node = state.items[callId];
      if (!node || node.kind !== "tool") return state;
      if (node.status === "cancelled" || node.durationMs !== undefined) {
        return state; // replayed result, or result for a cancelled call
      }
      const updated: ToolNode = {
        ...node,
        status: isInFlightToolStatus(node.status)
          ? toolStatusFromResult(ok)
          : node.status,
        result,
        ...(error !== undefined ? { error } : {}),
        durationMs,
      };
      return replaceToolNode(state, node, updated);
    }),

  toggleExpanded: (id) =>
    set((state) => ({
      expanded: { ...state.expanded, [id]: !state.expanded[id] },
    })),

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  reset: () => set({ ...initial }),
}));
