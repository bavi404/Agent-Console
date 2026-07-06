/**
 * WebSocketManager — the single, framework-free owner of the transport.
 *
 * It composes the pure building blocks of protocol/ into one cohesive manager:
 *
 *   raw frame ─▶ parser ─▶ SequenceBuffer ─▶ ordered, de-duplicated events
 *                                  │
 *   Heartbeat (liveness) ──────────┤
 *   WebSocketStateMachine ─────────┘
 *
 * Responsibilities:
 *   - open the socket and reconnect automatically with exponential backoff
 *   - heartbeat liveness (PING in -> PONG out; silence -> drop -> reconnect)
 *   - resume after reconnect (RESUME carries the last processed seq)
 *   - maintain the last processed sequence number
 *   - duplicate detection + sequence buffering (via SequenceBuffer)
 *   - send messages
 *   - expose everything through an observable interface
 *
 * Zero React. The socket, timers, clock and RNG are all injectable, so the
 * whole manager is deterministic under test.
 */
import type { ClientMessage, ParseError, ServerEvent } from "./types";
import { parseFrame } from "./parser";
import { SequenceBuffer } from "./sequenceBuffer";
import type { InsertResult } from "./sequenceBuffer";
import { Heartbeat } from "./heartbeat";
import {
  HeartbeatManager,
  isHeartbeatLikeFrame,
  type MalformedHeartbeat,
} from "./heartbeatManager";
import { WebSocketStateMachine } from "./stateMachine";
import type { WsSnapshot } from "./stateMachine";
import { reconnectDelayMs } from "../lib/reconnectBackoff";
import type { SkippedGap } from "./reorderBuffer";

/** Minimal structural WebSocket — keeps us off the DOM lib in tests. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Injectable timer surface (real timers by default). */
export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BackoffOptions {
  /** @deprecated Fixed schedule in lib/reconnectBackoff.ts; ignored at runtime. */
  baseMs?: number;
  /** @deprecated Fixed schedule in lib/reconnectBackoff.ts; ignored at runtime. */
  capMs?: number;
  /** @deprecated Fixed schedule in lib/reconnectBackoff.ts; ignored at runtime. */
  factor?: number;
}

export interface GapPolicyOptions {
  /** Max out-of-order frames to hold while waiting on a missing seq. */
  maxBuffer?: number;
  /** How long (ms) to wait on a gap before forcing reconnect. */
  maxGapAgeMs?: number;
}

export interface WebSocketManagerOptions {
  url: string;
  socketFactory?: WebSocketFactory;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  backoff?: BackoffOptions;
  /** Heartbeat poll cadence (ms). */
  pollMs?: number;
  /** Max ms to wait for socket OPEN before treating the attempt as failed. */
  connectTimeoutMs?: number;
  /** When a sequence gap blocks delivery, reconnect after these limits. */
  gapPolicy?: GapPolicyOptions;
  /** Highest sequence already processed before this manager existed. */
  startSeq?: number;
  now?: () => number;
  scheduler?: Scheduler;
  /** @deprecated Unused; kept for API compatibility. */
  random?: () => number;
  clientName?: string;
}

/* ------------------------------------------------------------------ */
/* Observable event surface                                           */
/* ------------------------------------------------------------------ */

export type ManagerEvent =
  | { type: "state"; snapshot: WsSnapshot }
  | { type: "message"; event: ServerEvent }
  | { type: "seq"; lastProcessed: number }
  | {
      type: "duplicate";
      seq: number;
      reason: Exclude<InsertResult, "buffered">;
    }
  | { type: "parseError"; error: ParseError }
  | { type: "heartbeatMalformed"; detail: MalformedHeartbeat }
  | { type: "retry"; attempt: number; delayMs: number }
  | { type: "seqGap"; gap: SkippedGap };

export type ManagerListener = (event: ManagerEvent) => void;

export interface Subscription {
  unsubscribe(): void;
}

const WS_OPEN = 1;

function parseFrameSeq(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const seq = (value as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 1
      ? seq
      : null;
  } catch {
    return null;
  }
}

const defaultScheduler: Scheduler = {
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (h, ms) => setTimeout(h, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class WebSocketManager {
  private readonly url: string;
  private readonly socketFactory: WebSocketFactory;
  private readonly heartbeatOpts: { intervalMs: number; timeoutMs: number };
  private readonly pollMs: number;
  private readonly connectTimeoutMs: number;
  private readonly gapMaxBuffer: number;
  private readonly gapMaxAgeMs: number;
  private readonly startSeq: number;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly clientName: string;

  private socket: WebSocketLike | null = null;
  private readonly machine = new WebSocketStateMachine();
  private buffer: SequenceBuffer<ServerEvent>;
  private heartbeat: Heartbeat;
  private readonly heartbeatManager: HeartbeatManager;
  private pollHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private connectTimeoutHandle: unknown = null;
  private gapSince: number | null = null;

  private readonly listeners = new Set<ManagerListener>();

  constructor(options: WebSocketManagerOptions) {
    this.url = options.url;
    this.socketFactory =
      options.socketFactory ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.heartbeatOpts = options.heartbeat ?? {
      intervalMs: 15000,
      timeoutMs: 45000,
    };
    this.pollMs = options.pollMs ?? 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.gapMaxBuffer = options.gapPolicy?.maxBuffer ?? 256;
    this.gapMaxAgeMs = options.gapPolicy?.maxGapAgeMs ?? 5_000;
    this.startSeq = options.startSeq ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clientName = options.clientName ?? "agent-console";

    this.buffer = new SequenceBuffer<ServerEvent>(this.startSeq);
    this.heartbeat = new Heartbeat(this.heartbeatOpts, this.now());
    this.heartbeatManager = new HeartbeatManager({
      now: this.now,
      sendPong: (nonce) => {
        this.send({ type: "PONG", nonce });
      },
      onMalformed: (detail) => {
        this.emit({ type: "heartbeatMalformed", detail });
      },
    });

    // The manager reacts to its own lifecycle: schedule backoff while
    // Reconnecting, and republish every state change to observers.
    this.machine.subscribe((snapshot) => {
      this.emit({ type: "state", snapshot });
      if (snapshot.state === "Reconnecting") {
        this.scheduleReconnect(snapshot.attempt);
      } else {
        this.clearReconnectTimer();
      }
    });
  }

  /* ----------------------------- observable ----------------------------- */

  /** Subscribe to every manager event. Returns a Subscription. */
  subscribe(listener: ManagerListener): Subscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Subscribe to a single event type. */
  on<T extends ManagerEvent["type"]>(
    type: T,
    handler: (event: Extract<ManagerEvent, { type: T }>) => void,
  ): Subscription {
    return this.subscribe((event) => {
      if (event.type === type) {
        handler(event as Extract<ManagerEvent, { type: T }>);
      }
    });
  }

  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /* ----------------------------- accessors ------------------------------ */

  get state(): WsSnapshot {
    return this.machine.snapshot;
  }

  /** Highest in-order sequence number processed so far. */
  get lastProcessedSeq(): number {
    return this.buffer.highestProcessed;
  }

  /* ------------------------------ control ------------------------------- */

  /** Open a fresh connection (valid from Disconnected or Error). */
  connect(): void {
    if (this.socket) return;
    if (!this.machine.send({ type: "CONNECT" }).ok) return;
    // Fresh transport, but keep the highest watermark already processed by this
    // manager so a remount/manual reconnect does not replay persisted UI state.
    const resumeSeq = Math.max(this.startSeq, this.buffer.highestProcessed);
    this.buffer = new SequenceBuffer<ServerEvent>(resumeSeq);
    this.heartbeat = new Heartbeat(this.heartbeatOpts, this.now());
    this.openSocket();
  }

  /** Force an immediate reconnect, bypassing the remaining backoff delay. */
  reconnectNow(): void {
    if (this.machine.state !== "Reconnecting") return;
    this.clearReconnectTimer();
    this.doReconnect();
  }

  /** User-requested terminal close. */
  close(): void {
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.heartbeatManager.dispose();
    this.machine.send({ type: "DISCONNECT" });
    this.teardownSocket();
  }

  /** Send a client message. Returns false if the socket is not open. */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /* --------------------------- socket lifecycle ------------------------- */

  private openSocket(): void {
    const socket = this.socketFactory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.clearConnectTimeout();
      // OPEN routes to Connected (fresh) or Resuming (after a reconnect).
      this.machine.send({ type: "OPEN" });
      this.heartbeat.reset(this.now());
      this.startPolling();
      // Resume the stream after the last sequence we actually processed.
      this.send({ type: "RESUME", lastSeq: this.buffer.highestProcessed });
    };
    socket.onmessage = (ev) => this.handleRaw(ev.data);
    socket.onerror = () => this.handleDrop();
    socket.onclose = () => this.handleDrop();

    this.scheduleConnectTimeout();
  }

  private handleDrop(): void {
    // If DROP isn't legal (e.g. we closed on purpose), there's nothing to do.
    if (!this.machine.can({ type: "DROP" })) return;
    this.stopPolling();
    this.teardownSocket();
    this.machine.send({ type: "DROP" }); // -> Reconnecting (schedules backoff)
  }

  private doReconnect(): void {
    if (this.machine.state !== "Reconnecting") return;
    // RETRY is a self-transition: no notify, so it won't reschedule us.
    this.machine.send({ type: "RETRY" });
    this.teardownSocket();
    this.heartbeat = new Heartbeat(this.heartbeatOpts, this.now());
    this.openSocket(); // keep the buffer (and its watermark) for RESUME
  }

  private teardownSocket(): void {
    this.clearConnectTimeout();
    this.stopPolling();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  /* ----------------------------- backoff -------------------------------- */

  private backoffDelay(attempt: number): number {
    return reconnectDelayMs(attempt);
  }

  private scheduleReconnect(attempt: number): void {
    this.clearReconnectTimer();
    const delayMs = this.backoffDelay(attempt);
    this.emit({ type: "retry", attempt, delayMs });
    this.reconnectHandle = this.scheduler.setTimeout(
      () => this.doReconnect(),
      delayMs,
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectHandle !== null) {
      this.scheduler.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutHandle !== null) {
      this.scheduler.clearTimeout(this.connectTimeoutHandle);
      this.connectTimeoutHandle = null;
    }
  }

  private scheduleConnectTimeout(): void {
    this.clearConnectTimeout();
    this.connectTimeoutHandle = this.scheduler.setTimeout(() => {
      this.connectTimeoutHandle = null;
      if (this.socket && this.socket.readyState !== WS_OPEN) {
        this.handleDrop();
      }
    }, this.connectTimeoutMs);
  }

  /** Stop polling and close the socket after an unrecoverable protocol error. */
  private haltTransport(): void {
    this.clearConnectTimeout();
    this.stopPolling();
    this.teardownSocket();
  }

  /* --------------------------- heartbeat poll --------------------------- */

  private startPolling(): void {
    this.stopPolling();
    this.pollHandle = this.scheduler.setInterval(
      () => this.poll(),
      this.pollMs,
    );
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      this.scheduler.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Exposed for tests; also called by the internal interval. */
  poll(now: number = this.now()): void {
    if (this.machine.state === "Error") return;
    this.evaluateGapPolicy(now);
    if (this.heartbeat.poll(now) === "dead") {
      this.handleDrop();
    }
  }

  /* --------------------------- frame handling --------------------------- */

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") return;
    if (this.machine.state === "Error") return;

    const result = parseFrame(data);
    if (!result.ok) {
      if (isHeartbeatLikeFrame(data)) {
        this.heartbeatManager.handleMalformed(data, result.error);
      } else {
        this.emit({ type: "parseError", error: result.error });
      }
      this.handleMalformedSeq(data);
      return;
    }

    const now = this.now();
    this.heartbeat.recordActivity(now);

    const event = result.event;

    // Heartbeat probe: answer via HeartbeatManager (echo challenge, never disconnect).
    if (event.type === "PING") {
      this.heartbeatManager.handlePing(event, now);
    }

    // Sequence buffering + duplicate detection live in SequenceBuffer.
    const inserted = this.buffer.insert(event);
    if (inserted !== "buffered") {
      this.emit({ type: "duplicate", seq: event.seq, reason: inserted });
      return;
    }

    let released = false;
    for (const delivered of this.buffer.drain()) {
      // The first frame after a reconnect completes the resume.
      if (this.machine.state === "Resuming") {
        this.machine.send({ type: "RESUMED" });
      }
      this.advance(delivered);
      if (delivered.type !== "PING") {
        this.emit({ type: "message", event: delivered });
      }
      released = true;
    }

    if (released) {
      this.emit({ type: "seq", lastProcessed: this.buffer.highestProcessed });
    }

    this.evaluateGapPolicy(now);
  }

  private handleMalformedSeq(data: string): void {
    const seq = parseFrameSeq(data);
    if (seq !== this.buffer.highestProcessed + 1) return;

    this.emit({
      type: "seqGap",
      gap: { from: seq, to: seq, reason: "malformed" },
    });
    this.handleDrop();
  }

  /**
   * When the buffer holds frames past a gap, wait briefly then reconnect so
   * RESUME can fill the hole — never skip seqs silently.
   */
  private evaluateGapPolicy(now: number): void {
    const state = this.machine.state;
    if (
      state === "Error" ||
      state === "Disconnected" ||
      state === "Reconnecting"
    ) {
      return;
    }

    if (!this.buffer.isGapBlocked()) {
      this.gapSince = null;
      return;
    }

    if (this.gapSince === null) this.gapSince = now;

    const overflow = this.buffer.size > this.gapMaxBuffer;
    const timedOut = now - this.gapSince >= this.gapMaxAgeMs;
    if (!overflow && !timedOut) return;

    const from = this.buffer.highestProcessed + 1;
    const to = this.buffer.minBufferedSeq() - 1;
    const reason: SkippedGap["reason"] = overflow ? "overflow" : "timeout";

    this.emit({ type: "seqGap", gap: { from, to, reason } });
    this.gapSince = null;
    this.handleDrop();
  }

  /**
   * Map a delivered server event onto a lifecycle transition. Every send is
   * validated by the FSM, so events that don't apply in the current state are
   * simply ignored (e.g. a second TOKEN while already Streaming).
   */
  private advance(event: ServerEvent): void {
    switch (event.type) {
      case "TOKEN":
        if (this.machine.state !== "Streaming") {
          this.machine.send({ type: "STREAM_START" });
        }
        break;
      case "STREAM_END":
        this.machine.send({ type: "STREAM_END" });
        break;
      case "TOOL_CALL":
        this.machine.send({ type: "TOOL_CALL" });
        break;
      case "TOOL_RESULT":
        this.machine.send({ type: "TOOL_RESULT" });
        break;
      case "ERROR":
        if (event.fatal) {
          this.machine.send({ type: "FATAL", reason: event.code });
          this.haltTransport();
        }
        break;
      case "CONTEXT_SNAPSHOT":
      case "PING":
        break;
    }
  }
}
