/**
 * Streaming transcript reducer (pure, immutable).
 *
 * The transcript is an ordered interleaving of two representations:
 *   - ChatMessage: a message owned by exactly one stream_id, grown token by
 *     token, carrying a StreamStatus.
 *   - ToolCard: a tool invocation with a server-driven execution status
 *     (queued → running → succeeded | failed | cancelled) that freezes the
 *     active message while any tool is in flight.
 *
 * Guarantees relied on by the renderer and the tool-card lifecycle:
 *   - Render tokens immediately ........... `applyToken` appends and returns at once.
 *   - Each stream_id owns its message ..... keyed by `messageId`.
 *   - Tool calls freeze the message ....... `addToolCall` flips the active
 *                                           stream to "paused"; it resumes once
 *                                           no tool is still in flight.
 *   - Resume from the exact character ..... `tokenCount` is the next expected
 *                                           token index; appends continue the
 *                                           same string, never restart it.
 *   - No duplicate text ................... a token whose index != tokenCount is
 *                                           ignored (replay / out-of-order safe).
 *   - Cards never overwrite each other .... every tool call is keyed by its own
 *                                           callId and appended; updates target
 *                                           that exact card. Multiple sequential
 *                                           calls coexist.
 *   - Immutable state .................... every op returns a new state and never
 *                                           mutates its input; unchanged ops
 *                                           return the same reference (so React
 *                                           can skip re-rendering → no flicker).
 *
 * Pure: no clocks, no IDs invented here — callers pass `now` and local ids.
 */
import type { ChatRole } from "@/protocol/types";
import {
  isInFlightToolStatus,
  isNotExecutedToolStatus,
  isTerminalToolStatus,
  mergeToolStatus,
  shouldApplyToolStatus,
  toolStatusFromResult,
  type ToolStatusFields,
} from "@/protocol/toolStatus";

export type { ToolStatus } from "@/protocol/toolStatus";

export type StreamStatus = "streaming" | "paused" | "complete" | "error";

export interface ChatMessage {
  kind: "message";
  /** stream_id — the message this stream owns. */
  id: string;
  role: ChatRole;
  text: string;
  status: StreamStatus;
  /** Tokens applied so far; also the index of the next expected token. */
  tokenCount: number;
  createdAt: number;
}

/**
 * A tool invocation card. Two independent axes:
 *   - `status`       execution lifecycle, owned by the server (TOOL_CALL implies
 *                    "queued"; TOOL_STATUS / TOOL_RESULT advance it). Monotonic —
 *                    see protocol/toolStatus.ts.
 *   - `acknowledged` delivery: whether this client has sent TOOL_ACK.
 */
export interface ToolCard extends ToolStatusFields {
  kind: "tool";
  id: string; // callId
  name: string;
  args: unknown;
  acknowledged: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
  createdAt: number;
}

export type TranscriptItem = ChatMessage | ToolCard;

export interface TranscriptState {
  /** Item ids in arrival order. */
  order: string[];
  items: Record<string, TranscriptItem>;
  /** The stream currently receiving tokens, if any. */
  activeStreamId: string | null;
}

export function emptyTranscript(): TranscriptState {
  return { order: [], items: {}, activeStreamId: null };
}

function getMessage(state: TranscriptState, id: string): ChatMessage | null {
  const item = state.items[id];
  return item && item.kind === "message" ? item : null;
}

function getTool(state: TranscriptState, id: string): ToolCard | null {
  const item = state.items[id];
  return item && item.kind === "tool" ? item : null;
}

function withItem(
  state: TranscriptState,
  item: TranscriptItem,
): TranscriptState {
  const isNew = state.items[item.id] === undefined;
  return {
    order: isNew ? [...state.order, item.id] : state.order,
    items: { ...state.items, [item.id]: item },
    activeStreamId: state.activeStreamId,
  };
}

export interface TokenInput {
  messageId: string;
  role: ChatRole;
  token: string;
  index: number;
  now: number;
}

/**
 * Apply a streamed token. Appends only the exact next token (index ===
 * tokenCount); duplicates, replays and out-of-order tokens are ignored so the
 * text is never duplicated and resume continues from the precise character.
 */
export function applyToken(
  state: TranscriptState,
  input: TokenInput,
): TranscriptState {
  const existing = state.items[input.messageId];

  if (existing) {
    if (existing.kind !== "message") return state; // id collision; ignore
    if (input.index !== existing.tokenCount) return state; // dup / gap -> no-op
    const updated: ChatMessage = {
      ...existing,
      text: existing.text + input.token,
      tokenCount: existing.tokenCount + 1,
      status: "streaming",
    };
    return {
      order: state.order,
      items: { ...state.items, [input.messageId]: updated },
      activeStreamId: input.messageId,
    };
  }

  // A brand-new stream must begin at index 0; anything else means we joined
  // mid-stream with no anchor, so we wait rather than render a partial fragment.
  if (input.index !== 0) return state;

  const message: ChatMessage = {
    kind: "message",
    id: input.messageId,
    role: input.role,
    text: input.token,
    status: "streaming",
    tokenCount: 1,
    createdAt: input.now,
  };
  return {
    order: [...state.order, input.messageId],
    items: { ...state.items, [input.messageId]: message },
    activeStreamId: input.messageId,
  };
}

/** Finalize a stream. */
export function endStream(
  state: TranscriptState,
  messageId: string,
): TranscriptState {
  const message = getMessage(state, messageId);
  if (!message) return state;
  const status: StreamStatus =
    message.status === "error" ? "error" : "complete";
  const updated: ChatMessage = { ...message, status };
  return {
    order: state.order,
    items: { ...state.items, [messageId]: updated },
    activeStreamId:
      state.activeStreamId === messageId ? null : state.activeStreamId,
  };
}

/** Mark the active stream (if any) as errored. */
export function failActiveStream(state: TranscriptState): TranscriptState {
  const id = state.activeStreamId;
  if (!id) return state;
  const message = getMessage(state, id);
  if (!message || message.status === "error") return state;
  return {
    order: state.order,
    items: { ...state.items, [id]: { ...message, status: "error" } },
    activeStreamId: null,
  };
}

function setActiveStatus(
  state: TranscriptState,
  from: StreamStatus,
  to: StreamStatus,
): TranscriptState {
  const id = state.activeStreamId;
  if (!id) return state;
  const message = getMessage(state, id);
  if (!message || message.status !== from) return state;
  return {
    order: state.order,
    items: { ...state.items, [id]: { ...message, status: to } },
    activeStreamId: id,
  };
}

/** Freeze the active stream because the agent started a tool call. */
export function pauseActiveStream(state: TranscriptState): TranscriptState {
  return setActiveStatus(state, "streaming", "paused");
}

/** Resume the active stream once its tool call returned. */
export function resumeActiveStream(state: TranscriptState): TranscriptState {
  return setActiveStatus(state, "paused", "streaming");
}

/* ----------------------------- tool cards ------------------------------ */

function hasToolInFlight(state: TranscriptState): boolean {
  for (const id of state.order) {
    const item = state.items[id];
    if (item?.kind === "tool" && isInFlightToolStatus(item.status)) return true;
  }
  return false;
}

/** Is any tool currently waiting for a human decision? */
export function hasToolAwaitingApproval(state: TranscriptState): boolean {
  for (const id of state.order) {
    const item = state.items[id];
    if (item?.kind === "tool" && item.status === "awaiting_approval") return true;
  }
  return false;
}

/** Resume the frozen stream once every tool has reached a terminal status. */
function resumeIfToolsIdle(state: TranscriptState): TranscriptState {
  return hasToolInFlight(state) ? state : resumeActiveStream(state);
}

function replaceTool(state: TranscriptState, tool: ToolCard): TranscriptState {
  return {
    order: state.order,
    items: { ...state.items, [tool.id]: tool },
    activeStreamId: state.activeStreamId,
  };
}

/** Create a new card and freeze the active stream if the tool is in flight. */
function insertTool(state: TranscriptState, tool: ToolCard): TranscriptState {
  const base = isInFlightToolStatus(tool.status)
    ? pauseActiveStream(state)
    : state;
  return withItem(base, tool);
}

export interface ToolCallInput {
  callId: string;
  name: string;
  args: unknown;
  now: number;
}

/**
 * Record a tool call (status "queued") and freeze the active stream.
 * Idempotent per callId, so a replayed TOOL_CALL never overwrites the card or
 * clobbers a later lifecycle state.
 */
export function addToolCall(
  state: TranscriptState,
  input: ToolCallInput,
): TranscriptState {
  if (state.items[input.callId]) return state; // never overwrite an existing card
  return insertTool(state, {
    kind: "tool",
    id: input.callId,
    name: input.name,
    args: input.args,
    status: "queued",
    acknowledged: false,
    createdAt: input.now,
  });
}

/** Record that TOOL_ACK was sent. Independent of execution status. */
export function acknowledgeToolCall(
  state: TranscriptState,
  callId: string,
): TranscriptState {
  const tool = getTool(state, callId);
  if (!tool || tool.acknowledged) return state;
  return replaceTool(state, { ...tool, acknowledged: true });
}

export interface ToolStatusInput extends ToolStatusFields {
  callId: string;
  name: string;
  args: unknown;
  now: number;
}

/**
 * Apply an explicit TOOL_STATUS.
 *
 *   - Unknown callId: the frame is self-describing, so the card is created
 *     from it (name + args + status).
 *   - Forward move (queued → running → terminal): status, detail and progress
 *     are updated.
 *   - Same in-flight status: a progress tick — detail/progress are refreshed.
 *   - Anything else (regression, post-terminal, exact duplicate): no-op, same
 *     reference returned.
 */
export function applyToolStatus(
  state: TranscriptState,
  input: ToolStatusInput,
): TranscriptState {
  const tool = getTool(state, input.callId);

  if (!tool) {
    if (state.items[input.callId]) return state; // id collision with a message
    const created: ToolCard = {
      kind: "tool",
      id: input.callId,
      name: input.name,
      args: input.args,
      status: input.status,
      acknowledged: false,
      createdAt: input.now,
    };
    return insertTool(state, mergeToolStatus(created, input));
  }

  if (!shouldApplyToolStatus(tool, input)) return state;
  const updated = mergeToolStatus(tool, input);
  const next = replaceTool(state, updated);
  return isTerminalToolStatus(updated.status) ? resumeIfToolsIdle(next) : next;
}

export interface ToolResultInput {
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Attach a TOOL_RESULT: sets the terminal status (unless TOOL_STATUS already
 * did) plus result/error/duration, then resumes the frozen stream if no other
 * tool is in flight. Idempotent: a replayed result, or a result for a
 * cancelled call, is ignored.
 */
export function completeToolCall(
  state: TranscriptState,
  input: ToolResultInput,
): TranscriptState {
  const tool = getTool(state, input.callId);
  if (!tool) return state;
  if (isNotExecutedToolStatus(tool.status) || tool.durationMs !== undefined) {
    return state;
  }
  const updated: ToolCard = {
    ...tool,
    status: isTerminalToolStatus(tool.status)
      ? tool.status
      : toolStatusFromResult(input.ok),
    result: input.result,
    ...(input.error !== undefined ? { error: input.error } : {}),
    durationMs: input.durationMs,
  };
  return resumeIfToolsIdle(replaceTool(state, updated));
}

/* ---------------------------- local messages --------------------------- */

export interface LocalMessageInput {
  id: string;
  text: string;
  now: number;
}

/** Append a completed local (user) message. */
export function addLocalMessage(
  state: TranscriptState,
  input: LocalMessageInput,
): TranscriptState {
  const message: ChatMessage = {
    kind: "message",
    id: input.id,
    role: "user",
    text: input.text,
    status: "complete",
    tokenCount: 0,
    createdAt: input.now,
  };
  return withItem(state, message);
}
