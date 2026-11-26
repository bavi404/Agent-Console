import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockAgentSocket,
  resetMockSession,
  mockSessionReplay,
} from "../lib/mockSocket";
import { POLICY_DEMO_DENIAL, POLICY_DEMO_PROMPT } from "../lib/demoScenario";
import { parseFrame } from "../protocol/parser";

describe("mock socket — policy denial scenario", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockSession();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies the tool call before execution and never sends a result", () => {
    const socket = new MockAgentSocket();
    const raw: string[] = [];
    socket.onmessage = (ev) => raw.push(String(ev.data));
    vi.advanceTimersByTime(700); // open + intro

    socket.send(
      JSON.stringify({ type: "USER_MESSAGE", text: POLICY_DEMO_PROMPT }),
    );
    vi.advanceTimersByTime(5000);
    socket.close();

    const events = raw.map((r) => {
      const parsed = parseFrame(r);
      if (!parsed.ok) throw new Error(parsed.error.detail);
      return parsed.event;
    });
    const call = events.find((e) => e.type === "TOOL_CALL");
    expect(call).toMatchObject({ name: POLICY_DEMO_DENIAL.tool });
    const callId = call?.type === "TOOL_CALL" ? call.callId : "";

    const statuses = events.flatMap((e) =>
      e.type === "TOOL_STATUS" && e.callId === callId ? [e] : [],
    );
    expect(statuses.map((e) => e.status)).toEqual(["denied"]);
    expect(statuses[0]).toMatchObject({
      policyRule: POLICY_DEMO_DENIAL.rule,
      detail: POLICY_DEMO_DENIAL.reason,
      args: POLICY_DEMO_DENIAL.args,
    });
    expect(events.some((e) => e.type === "TOOL_RESULT")).toBe(false);
    expect(events.at(-1)?.type).toBe("STREAM_END");

    // Replayable like everything else in the session log.
    expect(mockSessionReplay(0).some((e) => e.type === "TOOL_STATUS")).toBe(
      true,
    );
  });
});
