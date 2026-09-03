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
import {
  DEMO_INTRO,
  DEMO_WIKI_RESULT,
  isDemoPrompt,
} from "@/lib/demoScenario";

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
  private context: JsonObject = {
    session: "demo",
    scenario: "research-assistant",
    turns: 0,
  };

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
    this.deliver(this.token("m0", "assistant", DEMO_INTRO, 0), 250);
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
    if (isDemoPrompt(prompt)) {
      this.runDemoScenario(prompt);
      return;
    }
    this.runDemoNudge();
  }

  /**
   * Scripted research-assistant flow: calculator → wikipedia → synthesis.
   * Same frames every run — tuned for a demo recording.
   */
  private runDemoScenario(prompt: string): void {
    const base = Date.now();
    const msgId = `m-${base}`;
    const calcCall = `call-${base}-calc`;
    const wikiCall = `call-${base}-wiki`;

    this.context = {
      ...this.context,
      turns: Number(this.context.turns ?? 0) + 1,
      lastQuery: prompt,
    };

    // Out-of-order token delivery (exercises SequenceBuffer) with human-paced
    // gaps so a recording has time to show the UI reacting.
    const t0 = this.token(msgId, "assistant", "Let me ", 0);
    const t1 = this.token(msgId, "assistant", "split that into two checks: ", 1);
    const t2 = this.token(msgId, "assistant", "the calculation first, ", 2);
    const t3 = this.token(msgId, "assistant", "then a source-backed summary. ", 3);
    this.deliver(t0, 450);
    this.deliver(t2, 900);
    this.deliver(t1, 1350);
    this.deliver(t3, 1850);

    this.deliver(
      {
        type: "TOOL_CALL",
        seq: this.session.nextSeq(),
        callId: calcCall,
        name: "calculator",
        args: { expression: "2^20" },
      },
      2600,
    );
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: calcCall,
        ok: true,
        result: { expression: "2^20", result: 1048576 },
        durationMs: 920,
      },
      3800,
    );

    this.context = {
      ...this.context,
      lastTool: "calculator",
      calcResult: 1048576,
    };
    this.snapshot(3900);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "2^20 is 1,048,576. ",
        4,
      ),
      4550,
    );
    this.deliver(
      this.token(
        msgId,
        "assistant",
        "Now I will look up Ada Lovelace so the answer has a source. ",
        5,
      ),
      5250,
    );

    this.deliver(
      {
        type: "TOOL_CALL",
        seq: this.session.nextSeq(),
        callId: wikiCall,
        name: "wikipedia_lookup",
        args: { query: "Ada Lovelace" },
      },
      6100,
    );
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: wikiCall,
        ok: true,
        result: DEMO_WIKI_RESULT,
        durationMs: 1450,
      },
      7800,
    );

    this.context = {
      ...this.context,
      lastTool: "wikipedia_lookup",
      subject: "Ada Lovelace",
      sources: 1,
    };
    this.snapshot(7900);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "Ada Lovelace was a 19th-century mathematician known for her notes on " +
          "Babbage's Analytical Engine. ",
        6,
      ),
      8600,
    );
    this.deliver(
      this.token(
        msgId,
        "assistant",
        "She is often described as the first computer programmer, and the " +
          "calculation result is 1,048,576.",
        7,
      ),
      9500,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      10100,
    );
  }

  /** Gentle redirect when the user types something other than the demo prompt. */
  private runDemoNudge(): void {
    const msgId = `m-nudge-${Date.now()}`;
    this.deliver(
      this.token(
        msgId,
        "assistant",
        'Try: "Who was Ada Lovelace and what is 2^20?"',
        0,
      ),
      200,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      350,
    );
  }
}

export const mockSocketFactory = (): WebSocketLike => new MockAgentSocket();
