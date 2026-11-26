/**
 * Wire protocol types — the single source of truth for what crosses the socket.
 *
 * This file (and everything else in protocol/) is pure TypeScript: no React,
 * no Next, no Zustand. It can be exercised end-to-end in a plain Node test.
 *
 * Design notes:
 *  - Every server event and client message is a member of a discriminated
 *    union keyed on `type`. Narrowing on `type` gives you the exact payload.
 *  - There are no `any` types. Open-ended JSON is modelled by `JsonValue`;
 *    genuinely opaque blobs (tool args/results) are `unknown`, which forces
 *    callers to narrow before use.
 *  - Helper type guards live at the bottom for ergonomic, safe narrowing from
 *    `unknown` (e.g. straight off `JSON.parse`).
 */

import type { ApprovalOutcome, ToolDecision, ToolStatus } from "./toolStatus";

export const PROTOCOL_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* JSON value model (no `any`)                                        */
/* ------------------------------------------------------------------ */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Roles a chat message can take. */
export type ChatRole = "user" | "assistant" | "system";

/* ------------------------------------------------------------------ */
/* Server -> client events                                            */
/* ------------------------------------------------------------------ */

/** Discriminant tags for every server event. */
export const ServerEventType = {
  TOKEN: "TOKEN",
  TOOL_CALL: "TOOL_CALL",
  TOOL_RESULT: "TOOL_RESULT",
  TOOL_STATUS: "TOOL_STATUS",
  STREAM_END: "STREAM_END",
  CONTEXT_SNAPSHOT: "CONTEXT_SNAPSHOT",
  PING: "PING",
  ERROR: "ERROR",
} as const;

export type ServerEventType =
  (typeof ServerEventType)[keyof typeof ServerEventType];

/** Fields present on every server event. */
interface ServerBase {
  v: typeof PROTOCOL_VERSION;
  /** Monotonic per-session sequence number; drives ordering + RESUME. */
  seq: number;
  /** Server timestamp (epoch ms). */
  ts: number;
}

/** A streamed token belonging to an assistant (or other) message. */
export interface TokenEvent extends ServerBase {
  type: typeof ServerEventType.TOKEN;
  messageId: string;
  role: ChatRole;
  token: string;
  /** Position of this token within the message stream. */
  index: number;
}

/** The agent invoked a tool. Implies status "queued" until told otherwise. */
export interface ToolCallEvent extends ServerBase {
  type: typeof ServerEventType.TOOL_CALL;
  callId: string;
  name: string;
  /** Opaque arguments — narrow before use. */
  args: unknown;
  parentId?: string;
}

/** A previously announced tool call produced a result (or failed). */
export interface ToolResultEvent extends ServerBase {
  type: typeof ServerEventType.TOOL_RESULT;
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Explicit execution-status update for a tool call.
 *
 * Self-describing: carries the tool name and arguments alongside the status,
 * so a consumer can render the call from this frame alone (e.g. when it is the
 * first frame seen for `callId`). Statuses only move forward — see
 * `protocol/toolStatus.ts`. Result payloads still travel in TOOL_RESULT.
 */
export interface ToolStatusEvent extends ServerBase {
  type: typeof ServerEventType.TOOL_STATUS;
  callId: string;
  name: string;
  /** Opaque arguments — narrow before use. */
  args: unknown;
  status: ToolStatus;
  /** Optional human-readable progress note (e.g. "Fetching summary"). */
  detail?: string;
  /** Optional completion fraction in [0, 1]. */
  progress?: number;
  /**
   * For status "denied": id of the server-side policy rule that blocked the
   * call (e.g. "tool-access"). `detail` carries the human-readable reason.
   */
  policyRule?: string;
  /**
   * For status "awaiting_approval": deadline (epoch ms) after which the server
   * stops waiting and cancels the call.
   */
  expiresAt?: number;
  /**
   * Set when a human-approval request resolves: "approved" (with status
   * "running"), "rejected" (with "rejected"), or "expired" (with "cancelled").
   */
  approval?: ApprovalOutcome;
}

/** A message stream finished. */
export interface StreamEndEvent extends ServerBase {
  type: typeof ServerEventType.STREAM_END;
  messageId: string;
  reason: "complete" | "cancelled" | "error";
}

/** Full snapshot of the agent's context tree. */
export interface ContextSnapshotEvent extends ServerBase {
  type: typeof ServerEventType.CONTEXT_SNAPSHOT;
  context: JsonObject;
}

/** Server liveness probe; the client answers with a PONG carrying `nonce`. */
export interface PingEvent extends ServerBase {
  type: typeof ServerEventType.PING;
  nonce: string;
}

/** Server-reported error. `fatal` means the stream cannot continue. */
export interface ErrorEvent extends ServerBase {
  type: typeof ServerEventType.ERROR;
  code: string;
  message: string;
  fatal: boolean;
}

export type ServerEvent =
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolStatusEvent
  | StreamEndEvent
  | ContextSnapshotEvent
  | PingEvent
  | ErrorEvent;

/* ------------------------------------------------------------------ */
/* Client -> server messages                                          */
/* ------------------------------------------------------------------ */

export const ClientMessageType = {
  USER_MESSAGE: "USER_MESSAGE",
  PONG: "PONG",
  TOOL_ACK: "TOOL_ACK",
  TOOL_APPROVAL: "TOOL_APPROVAL",
  RESUME: "RESUME",
} as const;

export type ClientMessageType =
  (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** A user-authored message to the agent. */
export interface UserMessage {
  type: typeof ClientMessageType.USER_MESSAGE;
  text: string;
}

/** Reply to a server PING. */
export interface PongMessage {
  type: typeof ClientMessageType.PONG;
  nonce: string;
}

/** Acknowledge receipt of a tool call (e.g. for at-least-once delivery). */
export interface ToolAckMessage {
  type: typeof ClientMessageType.TOOL_ACK;
  callId: string;
}

/**
 * A human's decision on a tool call in status "awaiting_approval". Only the
 * first decision per callId counts; the server confirms it with TOOL_STATUS.
 */
export interface ToolApprovalMessage {
  type: typeof ClientMessageType.TOOL_APPROVAL;
  callId: string;
  decision: ToolDecision;
  /** Optional note, fed back to the model on rejection. */
  reason?: string;
}

/** Sent on (re)connect to resume the stream after the last seen sequence. */
export interface ResumeMessage {
  type: typeof ClientMessageType.RESUME;
  lastSeq: number;
}

export type ClientMessage =
  | UserMessage
  | PongMessage
  | ToolAckMessage
  | ToolApprovalMessage
  | ResumeMessage;

/* ------------------------------------------------------------------ */
/* Parser results                                                     */
/* ------------------------------------------------------------------ */

export type ParseError =
  | { code: "invalid_json"; detail: string }
  | { code: "not_an_object"; detail: string }
  | { code: "bad_version"; detail: string }
  | { code: "missing_field"; detail: string }
  | { code: "unknown_type"; detail: string };

export type ParseResult =
  | { ok: true; event: ServerEvent }
  | { ok: false; error: ParseError };

/* ------------------------------------------------------------------ */
/* Type guards                                                        */
/* ------------------------------------------------------------------ */

const SERVER_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(ServerEventType),
);
const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(ClientMessageType),
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural guard: does this unknown value look like any ServerEvent? */
export function isServerEvent(value: unknown): value is ServerEvent {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    SERVER_EVENT_TYPES.has(value.type)
  );
}

/** Structural guard: does this unknown value look like any ClientMessage? */
export function isClientMessage(value: unknown): value is ClientMessage {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    CLIENT_MESSAGE_TYPES.has(value.type)
  );
}

/**
 * Generic narrowing helper: `isServerEventOfType(e, ServerEventType.TOKEN)`
 * narrows `e` to `TokenEvent`. Works for any tag in the union.
 */
export function isServerEventOfType<T extends ServerEventType>(
  event: ServerEvent,
  type: T,
): event is Extract<ServerEvent, { type: T }> {
  return event.type === type;
}

export const isTokenEvent = (e: ServerEvent): e is TokenEvent =>
  e.type === ServerEventType.TOKEN;
export const isToolCallEvent = (e: ServerEvent): e is ToolCallEvent =>
  e.type === ServerEventType.TOOL_CALL;
export const isToolResultEvent = (e: ServerEvent): e is ToolResultEvent =>
  e.type === ServerEventType.TOOL_RESULT;
export const isToolStatusEvent = (e: ServerEvent): e is ToolStatusEvent =>
  e.type === ServerEventType.TOOL_STATUS;
export const isStreamEndEvent = (e: ServerEvent): e is StreamEndEvent =>
  e.type === ServerEventType.STREAM_END;
export const isContextSnapshotEvent = (
  e: ServerEvent,
): e is ContextSnapshotEvent => e.type === ServerEventType.CONTEXT_SNAPSHOT;
export const isPingEvent = (e: ServerEvent): e is PingEvent =>
  e.type === ServerEventType.PING;
export const isErrorEvent = (e: ServerEvent): e is ErrorEvent =>
  e.type === ServerEventType.ERROR;

export const isUserMessage = (m: ClientMessage): m is UserMessage =>
  m.type === ClientMessageType.USER_MESSAGE;
export const isPongMessage = (m: ClientMessage): m is PongMessage =>
  m.type === ClientMessageType.PONG;
export const isToolAckMessage = (m: ClientMessage): m is ToolAckMessage =>
  m.type === ClientMessageType.TOOL_ACK;
export const isToolApprovalMessage = (
  m: ClientMessage,
): m is ToolApprovalMessage => m.type === ClientMessageType.TOOL_APPROVAL;
export const isResumeMessage = (m: ClientMessage): m is ResumeMessage =>
  m.type === ClientMessageType.RESUME;
