import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  MockAgentSocket,
  resetMockSession,
  mockSessionReplay,
} from "../lib/mockSocket";
import { useChatStore } from "../stores/chatStore";
import { useTimelineStore } from "../stores/timelineStore";
import type { ServerEvent } from "../protocol/types";

describe("reconnect — store replay idempotency", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useTimelineStore.getState().reset();
  });

  it("deduplicates replayed tokens without duplicating stream text", () => {
    const chat = useChatStore.getState();
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "Hello ",
      index: 0,
    });
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "world",
      index: 1,
    });
    const before = useChatStore.getState().items["m1"];
    expect(before?.kind).toBe("message");

    // Server replays the same tokens after RESUME.
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "Hello ",
      index: 0,
    });
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "world",
      index: 1,
    });

    const after = useChatStore.getState().items["m1"];
    expect(after?.kind).toBe("message");
    if (after?.kind !== "message" || before?.kind !== "message") return;
    expect(after.text).toBe("Hello world");
    expect(after.text).toBe(before.text);
    expect(after.tokenCount).toBe(2);
  });

  it("continues a stream from the next token index after reconnect", () => {
    const chat = useChatStore.getState();
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "partial ",
      index: 0,
    });
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "partial ",
      index: 0,
    }); // replayed — ignored
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "restored",
      index: 1,
    }); // new events after reconnect

    const msg = useChatStore.getState().items["m1"];
    expect(msg?.kind).toBe("message");
    if (msg?.kind !== "message") return;
    expect(msg.text).toBe("partial restored");
    expect(msg.tokenCount).toBe(2);
  });

  it("does not duplicate tool cards when TOOL_CALL is replayed", () => {
    const chat = useChatStore.getState();
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "x",
      index: 0,
    });
    chat.addToolCall({ callId: "c1", name: "search", args: { q: 1 } });
    chat.acknowledgeToolCall("c1");
    chat.applyToolStatus({
      callId: "c1",
      name: "search",
      args: { q: 1 },
      status: "running",
    });
    chat.completeToolCall({
      callId: "c1",
      ok: true,
      result: { hits: 1 },
      durationMs: 10,
    });

    const orderBefore = [...useChatStore.getState().order];
    chat.addToolCall({ callId: "c1", name: "search", args: { q: 999 } });
    expect(useChatStore.getState().order).toEqual(orderBefore);
    const card = useChatStore.getState().items["c1"];
    expect(card?.kind).toBe("tool");
    if (card?.kind !== "tool") return;
    expect(card.status).toBe("succeeded");
    expect(card.args).toEqual({ q: 1 }); // not clobbered by replay
  });

  it("preserves transcript order across tool replay", () => {
    const chat = useChatStore.getState();
    chat.applyToken({
      messageId: "m1",
      role: "assistant",
      token: "a",
      index: 0,
    });
    chat.addToolCall({ callId: "c1", name: "f", args: null });
    const order = useChatStore.getState().order;
    chat.addToolCall({ callId: "c1", name: "f", args: null });
    expect(useChatStore.getState().order).toEqual(order);
  });

  it("does not reset store state when reset() is not called", () => {
    useChatStore.getState().appendLocal("user msg");
    expect(useChatStore.getState().order.length).toBe(1);
    // Simulating reconnect: no store reset API is invoked by the manager.
    expect(useChatStore.getState().order.length).toBe(1);
  });
});

describe("reconnect — mock session RESUME", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockSession();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the session log and replays only events after lastSeq", () => {
    const socket = new MockAgentSocket();
    const received: ServerEvent[] = [];
    socket.onmessage = (ev) => {
      received.push(JSON.parse(String(ev.data)) as ServerEvent);
    };

    vi.advanceTimersByTime(120); // onopen
    vi.advanceTimersByTime(500); // intro frames (last at +400ms)

    expect(received.length).toBeGreaterThan(0);
    const lastSeq = received[received.length - 1]!.seq;
    const replayFrom = lastSeq - 1;

    const replay = mockSessionReplay(replayFrom);
    expect(replay.length).toBe(1);
    expect(replay[0]!.seq).toBe(lastSeq);

    received.length = 0;
    socket.send(JSON.stringify({ type: "RESUME", lastSeq: replayFrom }));
    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBe(lastSeq);
  });

  it("does not re-run the intro on a second socket in the same session", () => {
    const first = new MockAgentSocket();
    const intro: ServerEvent[] = [];
    first.onmessage = (ev) =>
      intro.push(JSON.parse(String(ev.data)) as ServerEvent);

    vi.advanceTimersByTime(120);
    vi.advanceTimersByTime(500);
    const introCount = intro.length;

    first.close();

    const second = new MockAgentSocket();
    const again: ServerEvent[] = [];
    second.onmessage = (ev) =>
      again.push(JSON.parse(String(ev.data)) as ServerEvent);

    vi.advanceTimersByTime(120);
    vi.advanceTimersByTime(100); // no intro frames scheduled

    expect(again).toHaveLength(0); // no duplicate intro
    expect(introCount).toBeGreaterThan(0);
  });
});
