import { describe, it, expect } from "vitest";
import {
  WebSocketStateMachine,
  transition,
  canTransition,
  allowedEvents,
  isActive,
  WS_STATES,
} from "../protocol/stateMachine";
import type { WsState, WsEvent } from "../protocol/stateMachine";

const ev = (type: WsEvent["type"]): WsEvent =>
  type === "FATAL" ? { type, reason: "boom" } : ({ type } as WsEvent);

const EVENT_TYPES: WsEvent["type"][] = [
  "CONNECT",
  "OPEN",
  "STREAM_START",
  "STREAM_END",
  "TOOL_CALL",
  "TOOL_RESULT",
  "RESUMED",
  "DROP",
  "RETRY",
  "FATAL",
  "DISCONNECT",
];

describe("transition (pure)", () => {
  it("returns the next state for a legal transition", () => {
    expect(transition("Disconnected", ev("CONNECT"))).toBe("Connecting");
    expect(transition("Connecting", ev("OPEN"))).toBe("Connected");
    expect(transition("Connected", ev("STREAM_START"))).toBe("Streaming");
    expect(transition("Reconnecting", ev("OPEN"))).toBe("Resuming");
    expect(transition("Resuming", ev("RESUMED"))).toBe("Connected");
  });

  it("returns null for an illegal transition", () => {
    expect(transition("Disconnected", ev("OPEN"))).toBeNull();
    expect(transition("Disconnected", ev("STREAM_START"))).toBeNull();
    expect(transition("Connected", ev("TOOL_RESULT"))).toBeNull();
    expect(transition("Error", ev("OPEN"))).toBeNull();
    expect(transition("Disconnected", ev("DISCONNECT"))).toBeNull();
  });

  it("canTransition mirrors transition", () => {
    expect(canTransition("Connected", ev("DROP"))).toBe(true);
    expect(canTransition("Connected", ev("RESUMED"))).toBe(false);
  });

  it("FATAL leads to Error from every active state", () => {
    for (const s of WS_STATES) {
      if (s === "Disconnected" || s === "Error") {
        expect(transition(s, ev("FATAL"))).toBeNull();
      } else {
        expect(transition(s, ev("FATAL"))).toBe("Error");
      }
    }
  });

  it("DISCONNECT is terminal from every active state", () => {
    for (const s of WS_STATES) {
      if (s === "Disconnected") continue;
      expect(transition(s, ev("DISCONNECT"))).toBe("Disconnected");
    }
  });

  it("allowedEvents reflects the table", () => {
    expect(allowedEvents("Disconnected")).toEqual(["CONNECT"]);
    expect(new Set(allowedEvents("Error"))).toEqual(
      new Set(["CONNECT", "DISCONNECT"]),
    );
  });

  it("has an explicit yes/no answer for every state/event pair", () => {
    for (const state of WS_STATES) {
      const legal = new Set(allowedEvents(state));

      for (const type of EVENT_TYPES) {
        const expected = legal.has(type);
        expect(canTransition(state, ev(type))).toBe(expected);
        expect(transition(state, ev(type)) !== null).toBe(expected);
      }
    }
  });

  it("isActive is false only for Disconnected and Error", () => {
    for (const s of WS_STATES) {
      const expected = s !== "Disconnected" && s !== "Error";
      expect(isActive(s)).toBe(expected);
    }
  });
});

describe("WebSocketStateMachine — lifecycle", () => {
  it("starts Disconnected", () => {
    const m = new WebSocketStateMachine();
    expect(m.state).toBe("Disconnected");
    expect(m.attempt).toBe(0);
  });

  it("walks the happy path including a tool call", () => {
    const m = new WebSocketStateMachine();
    const path: Array<[WsEvent["type"], WsState]> = [
      ["CONNECT", "Connecting"],
      ["OPEN", "Connected"],
      ["STREAM_START", "Streaming"],
      ["STREAM_END", "Connected"],
      ["TOOL_CALL", "ToolCallPending"],
      ["TOOL_RESULT", "Connected"],
      ["DISCONNECT", "Disconnected"],
    ];
    for (const [type, expected] of path) {
      expect(m.send(ev(type)).ok).toBe(true);
      expect(m.state).toBe(expected);
    }
  });

  it("supports several sequential tool calls", () => {
    const m = new WebSocketStateMachine();
    m.send(ev("CONNECT"));
    m.send(ev("OPEN"));
    m.send(ev("TOOL_CALL"));
    expect(m.state).toBe("ToolCallPending");
    expect(m.send(ev("TOOL_CALL")).ok).toBe(true); // self
    expect(m.state).toBe("ToolCallPending");
    m.send(ev("TOOL_RESULT"));
    expect(m.state).toBe("Connected");
  });

  it("allows replay to resume directly into streaming or tool pending states", () => {
    const tokenReplay = new WebSocketStateMachine();
    tokenReplay.send(ev("CONNECT"));
    tokenReplay.send(ev("OPEN"));
    tokenReplay.send(ev("DROP"));
    tokenReplay.send(ev("OPEN"));
    expect(tokenReplay.state).toBe("Resuming");
    expect(tokenReplay.send(ev("STREAM_START")).ok).toBe(true);
    expect(tokenReplay.state).toBe("Streaming");

    const toolReplay = new WebSocketStateMachine();
    toolReplay.send(ev("CONNECT"));
    toolReplay.send(ev("OPEN"));
    toolReplay.send(ev("DROP"));
    toolReplay.send(ev("OPEN"));
    expect(toolReplay.send(ev("TOOL_CALL")).ok).toBe(true);
    expect(toolReplay.state).toBe("ToolCallPending");
  });
});

describe("WebSocketStateMachine — reconnect & attempts", () => {
  it("drops to Reconnecting, resumes, and reconnects", () => {
    const m = new WebSocketStateMachine();
    m.send(ev("CONNECT"));
    m.send(ev("OPEN"));
    expect(m.send(ev("DROP")).ok).toBe(true);
    expect(m.state).toBe("Reconnecting");
    expect(m.attempt).toBe(1);

    expect(m.send(ev("RETRY")).ok).toBe(true);
    expect(m.state).toBe("Reconnecting");
    expect(m.attempt).toBe(1); // RETRY does not bump attempts

    m.send(ev("OPEN"));
    expect(m.state).toBe("Resuming");
    m.send(ev("RESUMED"));
    expect(m.state).toBe("Connected");
    expect(m.attempt).toBe(0); // reset on successful connection
  });

  it("bumps attempt on each DROP and resets when Connected", () => {
    const m = new WebSocketStateMachine();
    m.send(ev("CONNECT"));
    m.send(ev("DROP")); // Connecting -> Reconnecting (1)
    m.send(ev("DROP")); // self (2)
    m.send(ev("DROP")); // self (3)
    expect(m.attempt).toBe(3);
    m.send(ev("OPEN")); // -> Resuming
    m.send(ev("RESUMED")); // -> Connected, reset
    expect(m.attempt).toBe(0);
  });

  it("recovers from Error only via CONNECT", () => {
    const m = new WebSocketStateMachine();
    m.send(ev("CONNECT"));
    m.send(ev("OPEN"));
    m.send(ev("FATAL"));
    expect(m.state).toBe("Error");
    expect(m.send(ev("OPEN")).ok).toBe(false); // not allowed
    expect(m.send(ev("DROP")).ok).toBe(false); // no reconnect from Error
    expect(m.send(ev("CONNECT")).ok).toBe(true);
    expect(m.state).toBe("Connecting");
  });
});

describe("WebSocketStateMachine — validation & notifications", () => {
  it("rejects invalid events without changing state", () => {
    const m = new WebSocketStateMachine();
    const result = m.send(ev("STREAM_START"));
    expect(result.ok).toBe(false);
    expect(m.state).toBe("Disconnected");
  });

  it("notifies subscribers only on observable change", () => {
    const m = new WebSocketStateMachine();
    const seen: WsState[] = [];
    const unsub = m.subscribe((s) => seen.push(s.state));

    m.send(ev("CONNECT")); // Connecting (notify)
    m.send(ev("OPEN")); // Connected (notify)
    m.send(ev("RESUMED")); // invalid from Connected (no notify)
    m.send(ev("DROP")); // Reconnecting (notify, attempt 1)
    m.send(ev("RETRY")); // self, no attempt change (no notify)

    expect(seen).toEqual(["Connecting", "Connected", "Reconnecting"]);
    unsub();
    m.send(ev("DISCONNECT"));
    expect(seen).toEqual(["Connecting", "Connected", "Reconnecting"]); // unsubscribed
  });
});
