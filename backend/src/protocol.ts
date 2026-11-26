/**
 * Wire protocol — server side.
 *
 * Mirrors the frontend's `protocol/types.ts` contract exactly. The client is
 * strict: v must be 1, seq must be an integer >= 1, ts finite, and each event
 * type carries specific required fields. Everything the server emits flows
 * through `Session` so seq numbering and RESUME replay stay correct.
 */

export const PROTOCOL_VERSION = 1 as const;

export type ChatRole = "user" | "assistant" | "system";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

interface ServerBase {
  v: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
}

export interface TokenEvent extends ServerBase {
  type: "TOKEN";
  messageId: string;
  role: ChatRole;
  token: string;
  index: number;
}

export interface ToolCallEvent extends ServerBase {
  type: "TOOL_CALL";
  callId: string;
  name: string;
  args: unknown;
  parentId?: string;
}

export interface ToolResultEvent extends ServerBase {
  type: "TOOL_RESULT";
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/** Mirrors protocol/toolStatus.ts on the frontend. Statuses only move forward. */
export type ToolStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied"
  | "awaiting_approval"
  | "rejected";

/** How a human-approval request resolved. Mirrors the frontend. */
export type ApprovalOutcome = "approved" | "rejected" | "expired";

/** Explicit, self-describing execution-status update for a tool call. */
export interface ToolStatusEvent extends ServerBase {
  type: "TOOL_STATUS";
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  detail?: string;
  /** Completion fraction in [0, 1]. */
  progress?: number;
  /** For "denied" / "awaiting_approval": the policy rule responsible. */
  policyRule?: string;
  /** For "awaiting_approval": decision deadline (epoch ms). */
  expiresAt?: number;
  /** Set when an approval request resolves. */
  approval?: ApprovalOutcome;
}

export interface StreamEndEvent extends ServerBase {
  type: "STREAM_END";
  messageId: string;
  reason: "complete" | "cancelled" | "error";
}

export interface ContextSnapshotEvent extends ServerBase {
  type: "CONTEXT_SNAPSHOT";
  context: JsonObject;
}

export interface PingEvent extends ServerBase {
  type: "PING";
  nonce: string;
}

export interface ErrorEvent extends ServerBase {
  type: "ERROR";
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

/** Everything except the envelope fields the Session fills in (v, seq, ts). */
type Frame =
  | Omit<TokenEvent, "v" | "seq" | "ts">
  | Omit<ToolCallEvent, "v" | "seq" | "ts">
  | Omit<ToolResultEvent, "v" | "seq" | "ts">
  | Omit<ToolStatusEvent, "v" | "seq" | "ts">
  | Omit<StreamEndEvent, "v" | "seq" | "ts">
  | Omit<ContextSnapshotEvent, "v" | "seq" | "ts">
  | Omit<PingEvent, "v" | "seq" | "ts">
  | Omit<ErrorEvent, "v" | "seq" | "ts">;

/* ------------------------------ client -> server ------------------------- */

export interface UserMessage {
  type: "USER_MESSAGE";
  text: string;
}
export interface PongMessage {
  type: "PONG";
  nonce: string;
}
export interface ToolAckMessage {
  type: "TOOL_ACK";
  callId: string;
}
export interface ToolApprovalMessage {
  type: "TOOL_APPROVAL";
  callId: string;
  decision: "approve" | "reject";
  reason?: string;
}
export interface ResumeMessage {
  type: "RESUME";
  lastSeq: number;
}

export type ClientMessage =
  | UserMessage
  | PongMessage
  | ToolAckMessage
  | ToolApprovalMessage
  | ResumeMessage;

export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const type = (json as { type?: unknown }).type;
  switch (type) {
    case "USER_MESSAGE":
      return typeof (json as UserMessage).text === "string"
        ? (json as UserMessage)
        : null;
    case "PONG":
      return typeof (json as PongMessage).nonce === "string"
        ? (json as PongMessage)
        : null;
    case "TOOL_ACK":
      return typeof (json as ToolAckMessage).callId === "string"
        ? (json as ToolAckMessage)
        : null;
    case "TOOL_APPROVAL": {
      const m = json as Partial<ToolApprovalMessage>;
      return typeof m.callId === "string" &&
        (m.decision === "approve" || m.decision === "reject") &&
        (m.reason === undefined || typeof m.reason === "string")
        ? (json as ToolApprovalMessage)
        : null;
    }
    case "RESUME":
      return Number.isFinite((json as ResumeMessage).lastSeq)
        ? (json as ResumeMessage)
        : null;
    default:
      return null;
  }
}

/**
 * Per-connection agent session.
 *
 * Owns the monotonic seq counter, the full event log (for RESUME replay), and
 * the rolling context snapshot. A dropped socket does NOT reset this — on
 * reconnect the client sends RESUME(lastSeq) and we replay everything after it.
 */
export class Session {
  private seq = 0;
  private readonly log: ServerEvent[] = [];
  private emitFn: (event: ServerEvent) => void = () => {};
  context: JsonObject = { session: "live", turns: 0 };

  /** Point the session at the currently-open socket. */
  bind(emit: (event: ServerEvent) => void): void {
    this.emitFn = emit;
  }

  /** Stamp a frame with v/seq/ts, record it, and emit it. */
  emit(frame: Frame): ServerEvent {
    this.seq += 1;
    const event = {
      v: PROTOCOL_VERSION,
      seq: this.seq,
      ts: Date.now(),
      ...frame,
    } as ServerEvent;
    this.log.push(event);
    this.emitFn(event);
    return event;
  }

  /** Replay every event with seq strictly greater than lastSeq. */
  replayAfter(lastSeq: number): void {
    for (const event of this.log) {
      if (event.seq > lastSeq) this.emitFn(event);
    }
  }

  snapshotContext(patch: JsonObject): void {
    this.context = { ...this.context, ...patch };
    this.emit({ type: "CONTEXT_SNAPSHOT", context: { ...this.context } });
  }
}
