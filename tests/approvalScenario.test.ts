import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgentSocket, resetMockSession } from "../lib/mockSocket";
import { APPROVAL_DEMO, APPROVAL_DEMO_PROMPT } from "../lib/demoScenario";
import { parseFrame } from "../protocol/parser";
import type { ServerEvent, ToolStatusEvent } from "../protocol/types";

function connect(): { socket: MockAgentSocket; events: ServerEvent[] } {
  const socket = new MockAgentSocket();
  const events: ServerEvent[] = [];
  socket.onmessage = (ev) => {
    const parsed = parseFrame(String(ev.data));
    if (!parsed.ok) throw new Error(parsed.error.detail);
    events.push(parsed.event);
  };
  return { socket, events };
}

const statuses = (events: ServerEvent[]): ToolStatusEvent[] =>
  events.filter((e): e is ToolStatusEvent => e.type === "TOOL_STATUS");

function startScenario() {
  const conn = connect();
  vi.advanceTimersByTime(700); // open + intro
  conn.socket.send(
    JSON.stringify({ type: "USER_MESSAGE", text: APPROVAL_DEMO_PROMPT }),
  );
  vi.advanceTimersByTime(1500);
  const request = statuses(conn.events).find(
    (e) => e.status === "awaiting_approval",
  );
  if (!request) throw new Error("no approval request");
  const decide = (decision: "approve" | "reject", reason?: string) =>
    conn.socket.send(
      JSON.stringify({
        type: "TOOL_APPROVAL",
        callId: request.callId,
        decision,
        ...(reason ? { reason } : {}),
      }),
    );
  return { ...conn, request, decide };
}

describe("mock socket — human approval scenario", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockSession();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parks the call with rule, reason, and deadline — nothing runs", () => {
    const { request, events } = startScenario();
    expect(request).toMatchObject({
      name: APPROVAL_DEMO.tool,
      policyRule: APPROVAL_DEMO.rule,
      detail: APPROVAL_DEMO.reason,
    });
    expect(request.expiresAt).toBeGreaterThan(Date.now());
    expect(events.some((e) => e.type === "TOOL_RESULT")).toBe(false);
    expect(
      events.some((e) => e.type === "STREAM_END" && e.messageId !== "m0"),
    ).toBe(false);
  });

  it("approve → running (approved) → result → answer; later decisions ignored", () => {
    const { decide, events, socket } = startScenario();
    decide("approve");
    decide("reject"); // ignored
    vi.advanceTimersByTime(3000);
    socket.close();
    expect(statuses(events).map((e) => [e.status, e.approval])).toEqual([
      ["awaiting_approval", undefined],
      ["running", "approved"],
    ]);
    expect(events.find((e) => e.type === "TOOL_RESULT")).toMatchObject({
      ok: true,
    });
    expect(events.at(-1)?.type).toBe("STREAM_END");
  });

  it("reject → rejected with the user's note; tool never runs", () => {
    const { decide, events, socket } = startScenario();
    decide("reject", "wrong recipients");
    vi.advanceTimersByTime(3000);
    socket.close();
    const final = statuses(events).at(-1);
    expect(final).toMatchObject({
      status: "rejected",
      approval: "rejected",
      detail: "wrong recipients",
    });
    expect(events.some((e) => e.type === "TOOL_RESULT")).toBe(false);
    expect(events.at(-1)?.type).toBe("STREAM_END");
  });

  it("expires without a decision", () => {
    const { decide, events, socket } = startScenario();
    vi.advanceTimersByTime(APPROVAL_DEMO.timeoutMs + 3000);
    decide("approve"); // too late: ignored
    vi.advanceTimersByTime(3000);
    socket.close();
    expect(statuses(events).at(-1)).toMatchObject({
      status: "cancelled",
      approval: "expired",
    });
    expect(events.some((e) => e.type === "TOOL_RESULT")).toBe(false);
  });

  it("a pending approval survives reconnect and can be decided on the new socket", () => {
    const first = startScenario();
    first.socket.close();

    const second = connect();
    vi.advanceTimersByTime(200);
    second.socket.send(JSON.stringify({ type: "RESUME", lastSeq: 0 }));
    expect(
      statuses(second.events).some(
        (e) =>
          e.callId === first.request.callId && e.status === "awaiting_approval",
      ),
    ).toBe(true);

    second.socket.send(
      JSON.stringify({
        type: "TOOL_APPROVAL",
        callId: first.request.callId,
        decision: "approve",
      }),
    );
    vi.advanceTimersByTime(3000);
    second.socket.close();
    expect(
      statuses(second.events).some(
        (e) => e.status === "running" && e.approval === "approved",
      ),
    ).toBe(true);
  });
});
