import { describe, it, expect } from "vitest";
import {
  WebSocketManager,
  type WebSocketLike,
  type Scheduler,
  type ManagerEvent,
} from "../protocol/webSocketManager";
import type { ClientMessage } from "../protocol/types";

/* ----------------------------- test doubles ----------------------------- */

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  /* helpers */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  deliverRaw(data: string): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onclose?.();
  }
  parsedSent(): ClientMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMessage);
  }
}

class ThrowingCloseSocket extends FakeSocket {
  override close(): void {
    this.readyState = 3;
    throw new Error("already gone");
  }
}

class FakeScheduler implements Scheduler {
  private id = 0;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();

  setTimeout(handler: () => void): unknown {
    const id = ++this.id;
    this.timeouts.set(id, handler);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  setInterval(handler: () => void): unknown {
    const id = ++this.id;
    this.intervals.set(id, handler);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  /** Fire (and consume) all pending timeouts. */
  flushTimeouts(): void {
    const handlers = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const fn of handlers) fn();
  }
}

const frame = (
  seq: number,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ v: 1, seq, ts: 0, type, ...extra });

const token = (seq: number, messageId = "m"): Record<string, unknown> =>
  frame(seq, "TOKEN", { messageId, role: "assistant", token: "x", index: 0 });

const fatalError = (seq: number): Record<string, unknown> =>
  frame(seq, "ERROR", { code: "fatal", message: "boom", fatal: true });

const toolCall = (seq: number): Record<string, unknown> =>
  frame(seq, "TOOL_CALL", { callId: "c1", name: "search", args: { q: "x" } });

const toolResult = (seq: number): Record<string, unknown> =>
  frame(seq, "TOOL_RESULT", {
    callId: "c1",
    ok: true,
    result: { hits: 1 },
    durationMs: 12,
  });

interface Harness {
  manager: WebSocketManager;
  sockets: FakeSocket[];
  scheduler: FakeScheduler;
  events: ManagerEvent[];
  clock: { t: number };
}

function makeManager(overrides: Record<string, unknown> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const events: ManagerEvent[] = [];
  const clock = { t: 0 };

  const manager = new WebSocketManager({
    url: "wss://test",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    heartbeat: { intervalMs: 100, timeoutMs: 1000 },
    backoff: { baseMs: 500, capMs: 10000, factor: 2 },
    pollMs: 50,
    now: () => clock.t,
    scheduler,
    ...overrides,
  });

  manager.subscribe((e) => events.push(e));
  return { manager, sockets, scheduler, events, clock };
}

const states = (events: ManagerEvent[]): string[] =>
  events.flatMap((e) => (e.type === "state" ? [e.snapshot.state] : []));
const messageSeqs = (events: ManagerEvent[]): number[] =>
  events.flatMap((e) => (e.type === "message" ? [e.event.seq] : []));

/* -------------------------------- tests --------------------------------- */

describe("WebSocketManager — connect & resume", () => {
  it("can be constructed with default optional dependencies", () => {
    const sockets: FakeSocket[] = [];
    const manager = new WebSocketManager({
      url: "wss://test",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    manager.connect();
    sockets[0]!.open();
    expect(manager.state.state).toBe("Connected");
    manager.close();
    expect(manager.state.state).toBe("Disconnected");
  });

  it("opens and sends RESUME with the last processed seq (0 initially)", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    expect(states(events)).toEqual(["Connecting"]);

    sockets[0]!.open();
    expect(states(events)).toEqual(["Connecting", "Connected"]);

    const resume = sockets[0]!.parsedSent().find((m) => m.type === "RESUME");
    expect(resume).toEqual({ type: "RESUME", lastSeq: 0 });
  });

  it("preserves the processed watermark across close and connect", () => {
    const { manager, sockets } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliver(token(1));

    manager.close();
    manager.connect();
    sockets[1]!.open();

    const resume = sockets[1]!.parsedSent().find((m) => m.type === "RESUME");
    expect(resume).toEqual({ type: "RESUME", lastSeq: 1 });
  });

  it("sends a USER_MESSAGE through the open socket", () => {
    const { manager, sockets } = makeManager();
    manager.connect();
    sockets[0]!.open();
    expect(manager.send({ type: "USER_MESSAGE", text: "hi" })).toBe(true);
    expect(sockets[0]!.parsedSent()).toContainEqual({
      type: "USER_MESSAGE",
      text: "hi",
    });
  });

  it("refuses to send while not open", () => {
    const { manager } = makeManager();
    expect(manager.send({ type: "USER_MESSAGE", text: "x" })).toBe(false);
  });
});

describe("WebSocketManager — ordering, dedupe & last seq", () => {
  it("releases events in order and tracks the watermark", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    const s = sockets[0]!;

    s.deliver(token(1)); // -> [1]
    s.deliver(token(3)); // buffered (gap at 2)
    s.deliver(token(2)); // -> [2,3]

    expect(messageSeqs(events)).toEqual([1, 2, 3]);
    expect(manager.lastProcessedSeq).toBe(3);
  });

  it("detects buffered duplicates and stale replays", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    const s = sockets[0]!;

    s.deliver(token(2)); // buffered (gap at 1)
    s.deliver(token(2)); // duplicate (still buffered)
    s.deliver(token(1)); // -> [1,2]
    s.deliver(token(1)); // stale (already processed)

    const dupes = events.flatMap((e) =>
      e.type === "duplicate" ? [e.reason] : [],
    );
    expect(dupes).toEqual(["duplicate", "stale"]);
    expect(messageSeqs(events)).toEqual([1, 2]);
  });

  it("deduplicates replayed frames after reconnect and preserves replay ordering", () => {
    const { manager, sockets, scheduler, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliver(token(1));
    sockets[0]!.deliver(token(2));
    sockets[0]!.drop();
    scheduler.flushTimeouts();
    sockets[1]!.open();

    expect(sockets[1]!.parsedSent()).toContainEqual({
      type: "RESUME",
      lastSeq: 2,
    });

    // Server may replay already processed frames and then arrive out of order.
    sockets[1]!.deliver(token(2)); // stale replay: ignored and reported
    sockets[1]!.deliver(token(4)); // held behind gap at seq 3
    sockets[1]!.deliver(token(3)); // gap fills, then 3 and 4 release in order

    const dupes = events.flatMap((e) =>
      e.type === "duplicate" ? [{ seq: e.seq, reason: e.reason }] : [],
    );
    expect(dupes).toContainEqual({ seq: 2, reason: "stale" });
    expect(messageSeqs(events)).toEqual([1, 2, 3, 4]);
    expect(manager.lastProcessedSeq).toBe(4);
  });

  it("answers PING with PONG and never surfaces it as a message", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    const s = sockets[0]!;

    s.deliver(frame(1, "PING", { nonce: "abc" }));
    expect(s.parsedSent()).toContainEqual({ type: "PONG", nonce: "abc" });
    expect(messageSeqs(events)).toEqual([]); // PING consumed
    expect(manager.lastProcessedSeq).toBe(1); // ...but its seq is accounted
  });

  it("echoes an empty challenge without disconnecting", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliver(frame(1, "PING", { nonce: "" }));
    expect(sockets[0]!.parsedSent()).toContainEqual({
      type: "PONG",
      nonce: "",
    });
    expect(manager.state.state).not.toBe("Reconnecting");
    expect(
      events.some((e) => e.type === "heartbeatMalformed"),
    ).toBe(false);
  });

  it("logs malformed heartbeat frames without disconnecting", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    const stateBefore = manager.state.state;

    sockets[0]!.deliverRaw(
      JSON.stringify({ v: 1, seq: 2, ts: 0, type: "PING" }),
    );

    expect(
      events.some((e) => e.type === "heartbeatMalformed"),
    ).toBe(true);
    expect(events.some((e) => e.type === "parseError")).toBe(false);
    expect(manager.state.state).toBe(stateBefore);
    expect(manager.state.state).not.toBe("Reconnecting");
  });

  it("emits a parseError for malformed frames", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliverRaw("{not json");
    expect(events.some((e) => e.type === "parseError")).toBe(true);
  });

  it("reconnects when a malformed frame occupies the expected seq", () => {
    const { manager, sockets, events, scheduler } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliverRaw(
      JSON.stringify({ v: 1, seq: 1, ts: 0, type: "STREAM_END" }),
    );

    expect(events.some((e) => e.type === "parseError")).toBe(true);
    expect(events).toContainEqual({
      type: "seqGap",
      gap: { from: 1, to: 1, reason: "malformed" },
    });
    expect(manager.state.state).toBe("Reconnecting");

    scheduler.flushTimeouts();
    sockets[1]!.open();
    expect(sockets[1]!.parsedSent()).toContainEqual({
      type: "RESUME",
      lastSeq: 0,
    });
  });

  it("moves to Error on a delivered fatal protocol error", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliver(fatalError(1));

    expect(manager.state.state).toBe("Error");
    expect(messageSeqs(events)).toEqual([1]);
  });

  it("ignores further frames after a fatal ERROR", () => {
    const { manager, sockets, events, scheduler } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliver(fatalError(1));
    expect(manager.state.state).toBe("Error");

    sockets[0]!.deliver(token(2));
    expect(messageSeqs(events)).toEqual([1]);

    // Heartbeat poll must not attempt another drop from Error.
    scheduler.intervals.set(99, () => manager.poll());
    manager.poll();
    expect(manager.state.state).toBe("Error");
  });

  it("advances lifecycle for tool calls, tool results, stream end, and context snapshots", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliver(toolCall(1));
    expect(manager.state.state).toBe("ToolCallPending");

    sockets[0]!.deliver(toolResult(2));
    expect(manager.state.state).toBe("Connected");

    sockets[0]!.deliver(token(3));
    expect(manager.state.state).toBe("Streaming");

    sockets[0]!.deliver(
      frame(4, "STREAM_END", { messageId: "m", reason: "complete" }),
    );
    expect(manager.state.state).toBe("Connected");

    sockets[0]!.deliver(frame(5, "CONTEXT_SNAPSHOT", { context: { a: 1 } }));
    expect(manager.state.state).toBe("Connected");

    sockets[0]!.deliver(
      frame(6, "ERROR", { code: "warn", message: "keep going", fatal: false }),
    );
    expect(manager.state.state).toBe("Connected");
    expect(messageSeqs(events)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("leaves ToolCallPending on a terminal TOOL_STATUS but not on running", () => {
    const { manager, sockets } = makeManager();
    manager.connect();
    sockets[0]!.open();
    const status = (seq: number, st: string): Record<string, unknown> =>
      frame(seq, "TOOL_STATUS", {
        callId: "c1",
        name: "search",
        args: { q: "x" },
        status: st,
      });

    sockets[0]!.deliver(toolCall(1));
    sockets[0]!.deliver(status(2, "running"));
    expect(manager.state.state).toBe("ToolCallPending");

    sockets[0]!.deliver(status(3, "cancelled"));
    expect(manager.state.state).toBe("Connected");

    // A stray TOOL_RESULT after cancellation is an illegal FSM move: ignored.
    sockets[0]!.deliver(toolResult(4));
    expect(manager.state.state).toBe("Connected");
  });

  it("ignores non-string socket payloads", () => {
    const { manager, sockets, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.onmessage?.({ data: { not: "a string frame" } });

    expect(manager.lastProcessedSeq).toBe(0);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });
});

describe("WebSocketManager — heartbeat & reconnect", () => {
  it("declares death on silence, then reconnects with backoff and resumes", () => {
    const { manager, sockets, scheduler, events, clock } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliver(token(1)); // process seq 1
    expect(manager.lastProcessedSeq).toBe(1);

    // Silence past the timeout -> heartbeat death -> drop.
    clock.t = 1000;
    manager.poll();
    expect(manager.state.state).toBe("Reconnecting");

    // Backoff scheduled: attempt 1, delay = base * factor^0 = 500.
    const retry = events.find((e) => e.type === "retry");
    expect(retry).toEqual({ type: "retry", attempt: 1, delayMs: 500 });

    // Fire the backoff timer -> a new socket is created.
    scheduler.flushTimeouts();
    expect(sockets).toHaveLength(2);

    // Reopen -> Resuming; RESUME carries the last processed seq.
    sockets[1]!.open();
    expect(manager.state.state).toBe("Resuming");
    expect(sockets[1]!.parsedSent()).toContainEqual({
      type: "RESUME",
      lastSeq: 1,
    });

    // First post-reconnect frame completes the resume.
    sockets[1]!.deliver(token(2));
    expect(manager.state.state).toBe("Streaming"); // TOKEN -> streaming
    expect(messageSeqs(events)).toEqual([1, 2]);
  });

  it("grows the backoff delay across consecutive failures", () => {
    const { manager, sockets, scheduler, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.drop(); // attempt 1
    scheduler.flushTimeouts(); // -> doReconnect, new socket
    sockets[1]!.drop(); // attempt 2
    scheduler.flushTimeouts();
    sockets[2]!.drop(); // attempt 3

    const delays = events.flatMap((e) =>
      e.type === "retry" ? [e.delayMs] : [],
    );
    expect(delays).toEqual([500, 1000, 2000]); // base * 2^(n-1)
  });

  it("caps the backoff delay at 10s", () => {
    const { manager, sockets, scheduler, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    for (let i = 0; i < 6; i++) {
      sockets[sockets.length - 1]!.drop();
      scheduler.flushTimeouts();
    }

    const delays = events.flatMap((e) =>
      e.type === "retry" ? [e.delayMs] : [],
    );
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
  });

  it("reconnectNow bypasses the remaining backoff", () => {
    const { manager, sockets } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.drop(); // Reconnecting, timer pending
    expect(manager.state.state).toBe("Reconnecting");

    manager.reconnectNow();
    expect(sockets).toHaveLength(2); // reconnected without firing the timer
  });

  it("times out a connect attempt that never opens", () => {
    const { manager, sockets, scheduler } = makeManager({
      connectTimeoutMs: 500,
    });
    manager.connect();
    expect(sockets).toHaveLength(1);
    expect(manager.state.state).toBe("Connecting");

    scheduler.flushTimeouts();
    expect(manager.state.state).toBe("Reconnecting");
  });

  it("connect is idempotent while a socket already exists", () => {
    const { manager, sockets } = makeManager();
    manager.connect();
    manager.connect();
    expect(sockets).toHaveLength(1);
  });
});

describe("WebSocketManager — terminal close", () => {
  it("closes and does not reconnect on a subsequent drop", () => {
    const { manager, sockets, scheduler, events } = makeManager();
    manager.connect();
    sockets[0]!.open();

    manager.close();
    expect(manager.state.state).toBe("Disconnected");

    // Any late socket events are ignored; no reconnection is scheduled.
    scheduler.flushTimeouts();
    expect(sockets).toHaveLength(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
  });

  it("clears a pending reconnect timer when closed intentionally", () => {
    const { manager, sockets, scheduler } = makeManager();
    manager.connect();
    sockets[0]!.open();
    sockets[0]!.drop();

    expect(scheduler.timeouts.size).toBe(1);
    manager.close();
    expect(scheduler.timeouts.size).toBe(0);

    scheduler.flushTimeouts();
    expect(sockets).toHaveLength(1);
  });

  it("swallows socket close errors during teardown", () => {
    const socket = new ThrowingCloseSocket();
    const manager = new WebSocketManager({
      url: "wss://test",
      socketFactory: () => socket,
      scheduler: new FakeScheduler(),
    });

    manager.connect();
    socket.open();

    expect(() => manager.close()).not.toThrow();
    expect(manager.state.state).toBe("Disconnected");
  });
});

describe("WebSocketManager — observable", () => {
  it("stops delivering after unsubscribe", () => {
    const { manager, sockets } = makeManager();
    const seen: ManagerEvent[] = [];
    const sub = manager.subscribe((e) => seen.push(e));

    manager.connect();
    sockets[0]!.open();
    const count = seen.length;
    expect(count).toBeGreaterThan(0);

    sub.unsubscribe();
    sockets[0]!.deliver(token(1));
    expect(seen.length).toBe(count); // no further events for this listener
  });

  it("on() filters to a single event type", () => {
    const { manager, sockets } = makeManager();
    const seqEvents: number[] = [];
    manager.on("seq", (e) => seqEvents.push(e.lastProcessed));

    manager.connect();
    sockets[0]!.open();
    sockets[0]!.deliver(token(1));
    sockets[0]!.deliver(token(2));

    expect(seqEvents).toEqual([1, 2]);
  });
});

describe("WebSocketManager — gap policy", () => {
  it("reconnects when a gap blocks delivery past maxGapAgeMs", () => {
    const { manager, sockets, events, clock } = makeManager({
      gapPolicy: { maxBuffer: 256, maxGapAgeMs: 500 },
    });
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliver(token(1));
    sockets[0]!.deliver(token(3)); // gap at 2
    expect(manager.state.state).toBe("Streaming");

    clock.t = 500;
    manager.poll();

    const gap = events.find((e) => e.type === "seqGap");
    expect(gap).toEqual({
      type: "seqGap",
      gap: { from: 2, to: 2, reason: "timeout" },
    });
    expect(manager.state.state).toBe("Reconnecting");
    expect(messageSeqs(events)).toEqual([1]); // 3 not released
  });

  it("reconnects when buffered out-of-order frames exceed maxBuffer", () => {
    const { manager, sockets, events } = makeManager({
      gapPolicy: { maxBuffer: 2, maxGapAgeMs: 60_000 },
    });
    manager.connect();
    sockets[0]!.open();

    sockets[0]!.deliver(token(1));
    sockets[0]!.deliver(token(3));
    sockets[0]!.deliver(token(4));
    sockets[0]!.deliver(token(5)); // 3 held frames > maxBuffer 2

    const gap = events.find((e) => e.type === "seqGap");
    expect(gap).toEqual({
      type: "seqGap",
      gap: { from: 2, to: 2, reason: "overflow" },
    });
    expect(manager.state.state).toBe("Reconnecting");
    expect(messageSeqs(events)).toEqual([1]);
  });
});
