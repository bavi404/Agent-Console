/**
 * HeartbeatManager — server PING / client PONG handling.
 *
 * Responsibilities:
 *   - Reply to every valid PING within `replyDeadlineMs` (default 3s).
 *   - Echo the challenge (`nonce`) exactly in the PONG, including `""`.
 *   - Log malformed heartbeat frames without throwing.
 *   - Never initiate a disconnect because of heartbeat issues.
 *
 * Pure decision logic; the owner supplies `sendPong`.
 */
import type { ParseError, PingEvent } from "./types";
import { ServerEventType } from "./types";

/** Default upper bound for sending a PONG after a PING arrives. */
export const PONG_REPLY_DEADLINE_MS = 3_000;

export interface MalformedHeartbeat {
  reason: string;
  detail?: string;
  raw?: string;
  seq?: number;
}

export interface HeartbeatManagerOptions {
  /** Max ms after PING receipt to send PONG. Defaults to 3000. */
  replyDeadlineMs?: number;
  now?: () => number;
  sendPong: (nonce: string) => void;
  /** Called for malformed heartbeat frames (must not throw). */
  onMalformed?: (entry: MalformedHeartbeat) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort detection of a heartbeat frame that failed validation.
 * Used only to route parse failures into heartbeat logging.
 */
export function isHeartbeatLikeFrame(raw: string): boolean {
  try {
    const json: unknown = JSON.parse(raw);
    return isRecord(json) && json.type === ServerEventType.PING;
  } catch {
    return raw.includes('"PING"');
  }
}

export class HeartbeatManager {
  private readonly replyDeadlineMs: number;
  private readonly now: () => number;
  private readonly sendPong: (nonce: string) => void;
  private readonly onMalformed: ((entry: MalformedHeartbeat) => void) | null;

  constructor(options: HeartbeatManagerOptions) {
    this.replyDeadlineMs = options.replyDeadlineMs ?? PONG_REPLY_DEADLINE_MS;
    this.now = options.now ?? (() => Date.now());
    this.sendPong = options.sendPong;
    this.onMalformed = options.onMalformed ?? null;
  }

  /**
   * Handle a validated PING. Sends a PONG that echoes `nonce` exactly
   * (including an empty string) immediately — well within the deadline.
   */
  handlePing(ping: PingEvent, receivedAt: number = this.now()): void {
    try {
      if (typeof ping.nonce !== "string") {
        this.logMalformed({
          reason: "invalid_nonce_type",
          detail: typeof ping.nonce,
          seq: ping.seq,
        });
        return;
      }

      const elapsed = this.now() - receivedAt;
      if (elapsed > this.replyDeadlineMs) {
        this.logMalformed({
          reason: "pong_deadline_missed",
          detail: `elapsed ${elapsed}ms`,
          seq: ping.seq,
        });
      }

      // Echo the challenge exactly — empty string is valid.
      this.sendPong(ping.nonce);
    } catch (err) {
      this.logMalformed({
        reason: "handle_ping_threw",
        detail: err instanceof Error ? err.message : String(err),
        seq: ping.seq,
      });
    }
  }

  /** Log a malformed heartbeat wire frame. Never throws; never disconnects. */
  handleMalformed(raw: string, error?: ParseError): void {
    try {
      let seq: number | undefined;
      try {
        const json: unknown = JSON.parse(raw);
        if (isRecord(json) && typeof json.seq === "number") seq = json.seq;
      } catch {
        // ignore secondary parse failure
      }
      this.logMalformed({
        reason: error?.code ?? "malformed_heartbeat",
        ...(error?.detail !== undefined ? { detail: error.detail } : {}),
        raw,
        ...(seq !== undefined ? { seq } : {}),
      });
    } catch {
      // Swallow — never crash the transport on bad heartbeat data.
    }
  }

  /** No-op; kept for symmetric lifecycle with WebSocketManager. */
  dispose(): void {}

  private logMalformed(entry: MalformedHeartbeat): void {
    try {
      this.onMalformed?.(entry);
    } catch {
      // Observer threw — still must not crash the manager.
    }
  }
}
