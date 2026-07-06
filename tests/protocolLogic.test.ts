import { describe, expect, it } from "vitest";
import { Heartbeat } from "../protocol/heartbeat";
import { parseFrame } from "../protocol/parser";
import {
  ClientMessageType,
  ServerEventType,
  isClientMessage,
  isContextSnapshotEvent,
  isErrorEvent,
  isPingEvent,
  isPongMessage,
  isResumeMessage,
  isServerEvent,
  isServerEventOfType,
  isStreamEndEvent,
  isTokenEvent,
  isToolAckMessage,
  isToolCallEvent,
  isToolResultEvent,
  isUserMessage,
  type ClientMessage,
  type ServerEvent,
} from "../protocol/types";

const base = { v: 1, seq: 1, ts: 0 };

function parse(raw: Record<string, unknown>): ServerEvent {
  const result = parseFrame(JSON.stringify(raw));
  if (!result.ok) throw new Error(result.error.detail);
  return result.event;
}

describe("parseFrame — protocol event validation", () => {
  it("parses every supported server event type", () => {
    const events = [
      parse({
        ...base,
        type: "TOKEN",
        messageId: "m1",
        role: "assistant",
        token: "hi",
        index: 0,
      }),
      parse({ ...base, seq: 2, type: "TOOL_CALL", callId: "c1", name: "fs", args: {} }),
      parse({
        ...base,
        seq: 3,
        type: "TOOL_RESULT",
        callId: "c1",
        ok: false,
        error: "nope",
        durationMs: 10,
      }),
      parse({
        ...base,
        seq: 4,
        type: "STREAM_END",
        messageId: "m1",
        reason: "cancelled",
      }),
      parse({
        ...base,
        seq: 5,
        type: "CONTEXT_SNAPSHOT",
        context: { cwd: "/tmp" },
      }),
      parse({ ...base, seq: 6, type: "PING", nonce: "" }),
      parse({
        ...base,
        seq: 7,
        type: "ERROR",
        code: "E",
        message: "bad",
        fatal: false,
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "TOKEN",
      "TOOL_CALL",
      "TOOL_RESULT",
      "STREAM_END",
      "CONTEXT_SNAPSHOT",
      "PING",
      "ERROR",
    ]);
  });

  it("returns typed failures for invalid envelopes and payloads", () => {
    expect(parseFrame("{nope").ok).toBe(false);
    expect(parseFrame("[]")).toEqual({
      ok: false,
      error: { code: "not_an_object", detail: "object" },
    });
    expect(parseFrame(JSON.stringify({ ...base, v: 2, type: "TOKEN" }))).toEqual({
      ok: false,
      error: { code: "bad_version", detail: "2" },
    });
    expect(parseFrame(JSON.stringify({ v: 1, ts: 0, type: "TOKEN" }))).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "seq" },
    });
    expect(parseFrame(JSON.stringify({ v: 1, seq: 1, type: "TOKEN" }))).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "ts" },
    });
    expect(parseFrame(JSON.stringify({ ...base, type: "NOPE" }))).toEqual({
      ok: false,
      error: { code: "unknown_type", detail: "NOPE" },
    });
    expect(parseFrame(JSON.stringify({ ...base, type: "STREAM_END" }))).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "messageId" },
    });
    expect(
      parseFrame(
        JSON.stringify({
          ...base,
          type: "TOOL_CALL",
          callId: "c",
          name: "n",
        }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "args" },
    });
    expect(
      parseFrame(
        JSON.stringify({
          ...base,
          seq: 0,
          type: "TOKEN",
          messageId: "m",
          role: "assistant",
          token: "x",
          index: 0,
        }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "seq" },
    });
    expect(
      parseFrame(
        JSON.stringify({
          ...base,
          type: "TOKEN",
          messageId: "m",
          role: "narrator",
          token: "x",
          index: 0,
        }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "role" },
    });
  });
});

describe("protocol type guards", () => {
  it("narrows all server event variants", () => {
    const events: ServerEvent[] = [
      parse({
        ...base,
        type: ServerEventType.TOKEN,
        messageId: "m",
        role: "assistant",
        token: "x",
        index: 0,
      }),
      parse({ ...base, seq: 2, type: ServerEventType.TOOL_CALL, callId: "c", name: "n", args: {} }),
      parse({
        ...base,
        seq: 3,
        type: ServerEventType.TOOL_RESULT,
        callId: "c",
        ok: true,
        durationMs: 1,
      }),
      parse({
        ...base,
        seq: 4,
        type: ServerEventType.STREAM_END,
        messageId: "m",
        reason: "complete",
      }),
      parse({
        ...base,
        seq: 5,
        type: ServerEventType.CONTEXT_SNAPSHOT,
        context: {},
      }),
      parse({ ...base, seq: 6, type: ServerEventType.PING, nonce: "n" }),
      parse({
        ...base,
        seq: 7,
        type: ServerEventType.ERROR,
        code: "E",
        message: "bad",
        fatal: true,
      }),
    ];

    expect(events.every(isServerEvent)).toBe(true);
    expect(isServerEvent(null)).toBe(false);
    expect(isServerEvent({ type: "UNKNOWN" })).toBe(false);
    expect(isServerEventOfType(events[0]!, ServerEventType.TOKEN)).toBe(true);
    expect(isTokenEvent(events[0]!)).toBe(true);
    expect(isToolCallEvent(events[1]!)).toBe(true);
    expect(isToolResultEvent(events[2]!)).toBe(true);
    expect(isStreamEndEvent(events[3]!)).toBe(true);
    expect(isContextSnapshotEvent(events[4]!)).toBe(true);
    expect(isPingEvent(events[5]!)).toBe(true);
    expect(isErrorEvent(events[6]!)).toBe(true);
  });

  it("narrows all client message variants", () => {
    const messages: ClientMessage[] = [
      { type: ClientMessageType.USER_MESSAGE, text: "hi" },
      { type: ClientMessageType.PONG, nonce: "n" },
      { type: ClientMessageType.TOOL_ACK, callId: "c" },
      { type: ClientMessageType.RESUME, lastSeq: 42 },
    ];

    expect(messages.every(isClientMessage)).toBe(true);
    expect(isClientMessage([])).toBe(false);
    expect(isClientMessage({ type: "NOPE" })).toBe(false);
    expect(isUserMessage(messages[0]!)).toBe(true);
    expect(isPongMessage(messages[1]!)).toBe(true);
    expect(isToolAckMessage(messages[2]!)).toBe(true);
    expect(isResumeMessage(messages[3]!)).toBe(true);
  });
});

describe("Heartbeat — liveness decisions", () => {
  it("idles, pings once per interval window, then declares dead", () => {
    const hb = new Heartbeat({ intervalMs: 100, timeoutMs: 300 }, 0);

    expect(hb.poll(99)).toBe("idle");
    expect(hb.poll(100)).toBe("ping");
    expect(hb.poll(150)).toBe("idle");
    expect(hb.poll(200)).toBe("ping");
    expect(hb.poll(300)).toBe("dead");
  });

  it("activity and reset clear pending ping state", () => {
    const hb = new Heartbeat({ intervalMs: 100, timeoutMs: 300 }, 0);

    expect(hb.poll(100)).toBe("ping");
    hb.recordActivity(150);
    expect(hb.poll(200)).toBe("idle");
    expect(hb.poll(250)).toBe("ping");

    hb.reset(500);
    expect(hb.poll(550)).toBe("idle");
    expect(hb.poll(600)).toBe("ping");
  });
});
