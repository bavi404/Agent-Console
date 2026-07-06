/**
 * Mock agent socket — a development harness, not part of the protocol.
 *
 * Implements WebSocketLike and simulates a real agent session with:
 *   - out-of-order token delivery (reorder buffer exercise)
 *   - PING heartbeats
 *   - RESUME replay of all events after `lastSeq` (reconnect exercise)
 *
 * Session state survives socket replacement so reconnect never resets the app:
 * the client keeps its stores, sends RESUME(lastSeq), and receives only the
 * frames it missed.
 */
import type {
  ChatRole,
  ClientMessage,
  JsonObject,
  ServerEvent,
} from "@/protocol/types";
import type { WebSocketLike } from "@/protocol/webSocketManager";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Frame = DistributiveOmit<ServerEvent, "v" | "ts">;

const HEARTBEAT_MS = 10000;

/** Shared across socket instances — simulates server-side session memory. */
class MockSession {
  /** Every event the server has ever emitted, in ascending seq order. */
  readonly log: ServerEvent[] = [];
  private seq = 0;
  introPlayed = false;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  record(frame: Frame): ServerEvent {
    const full = { v: 1, ts: Date.now(), ...frame } as ServerEvent;
    this.log.push(full);
    return full;
  }

  /** Replay events with seq strictly greater than `lastSeq`. */
  replayAfter(lastSeq: number): ServerEvent[] {
    return this.log.filter((e) => e.seq > lastSeq);
  }
}

let session = new MockSession();

/** Reset shared session state (tests only). */
export function resetMockSession(): void {
  session = new MockSession();
}

/** @internal Test helper — events recorded in the shared session log. */
export function mockSessionReplay(lastSeq: number): ServerEvent[] {
  return session.replayAfter(lastSeq);
}

function getSession(): MockSession {
  return session;
}

export class MockAgentSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private readonly session = getSession();
  private nonce = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private context: JsonObject = { session: "mock", turns: 0 };

  constructor() {
    this.after(120, () => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.();
      if (!this.session.introPlayed) {
        this.session.introPlayed = true;
        this.runIntro();
      }
      this.heartbeat = setInterval(
        () =>
          this.deliver(
            {
              type: "PING",
              seq: this.session.nextSeq(),
              nonce: `n${(this.nonce += 1)}`,
            },
            0,
          ),
        HEARTBEAT_MS,
      );
    });
  }

  send(raw: string): void {
    let msg: ClientMessage | null = null;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "USER_MESSAGE":
        this.runReply(msg.text);
        break;
      case "RESUME":
        this.replay(msg.lastSeq);
        break;
      case "PONG":
      case "TOOL_ACK":
        break;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.onclose?.();
  }

  /* ----------------------------------------------------------------- */

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
  }

  private emit(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  private deliver(frame: Frame, atMs: number): void {
    const full = this.session.record(frame);
    this.after(atMs, () => {
      if (!this.closed) this.emit(full);
    });
  }

  /** Immediately replay missed events after a reconnect. */
  private replay(lastSeq: number): void {
    for (const event of this.session.replayAfter(lastSeq)) {
      this.emit(event);
    }
  }

  private token(
    messageId: string,
    role: ChatRole,
    text: string,
    index: number,
  ): Frame {
    return {
      type: "TOKEN",
      seq: this.session.nextSeq(),
      messageId,
      role,
      token: text,
      index,
    };
  }

  private snapshot(atMs: number): void {
    this.deliver(
      {
        type: "CONTEXT_SNAPSHOT",
        seq: this.session.nextSeq(),
        context: { ...this.context },
      },
      atMs,
    );
  }

  private runIntro(): void {
    this.snapshot(0);
    this.deliver(
      this.token(
        "m0",
        "assistant",
        'Connected to the mock agent. Ask me anything — try "weather".',
        0,
      ),
      250,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: "m0",
        reason: "complete",
      },
      400,
    );
  }

  private runReply(prompt: string): void {
    const base = Date.now();
    const msgId = `m-${base}`;
    const call1 = `call-${base}-1`;
    const call2 = `call-${base}-2`;
    this.context = {
      ...this.context,
      turns: Number(this.context.turns ?? 0) + 1,
      lastQuery: prompt,
    };

    const tokenA = this.token(msgId, "assistant", "Let me ", 0);
    const tokenB = this.token(msgId, "assistant", "look into ", 1);
    const tokenC = this.token(msgId, "assistant", `"${prompt}". `, 2);
    this.deliver(tokenA, 250);
    this.deliver(tokenC, 380);
    this.deliver(tokenB, 520);

    this.deliver(
      {
        type: "TOOL_CALL",
        seq: this.session.nextSeq(),
        callId: call1,
        name: "search_web",
        args: { query: prompt, top_k: 3 },
      },
      700,
    );
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: call1,
        ok: true,
        result: {
          hits: [
            { title: "Result A", score: 0.91 },
            { title: "Result B", score: 0.74 },
          ],
        },
        durationMs: 640,
      },
      1400,
    );

    this.context = { ...this.context, results: { count: 2 } };
    this.snapshot(1450);

    this.deliver(
      this.token(msgId, "assistant", "Top hit looks promising — ", 3),
      1600,
    );

    this.deliver(
      {
        type: "TOOL_CALL",
        seq: this.session.nextSeq(),
        callId: call2,
        name: "fetch_page",
        args: { url: "https://example.com/result-a" },
      },
      1750,
    );
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: call2,
        ok: true,
        result: { status: 200, words: 1280 },
        durationMs: 410,
      },
      2400,
    );

    this.context = { ...this.context, fetched: true };
    this.snapshot(2450);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "based on what I found, here's a concise answer.",
        4,
      ),
      2600,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      2750,
    );
  }
}

export const mockSocketFactory = (): WebSocketLike => new MockAgentSocket();
