import { beforeEach, describe, expect, it } from "vitest";
import { useApprovalStore } from "../stores/approvalStore";
import type { ClientMessage } from "../protocol/types";

describe("approvalStore — client decisions", () => {
  let sent: ClientMessage[];
  let online: boolean;

  beforeEach(() => {
    sent = [];
    online = true;
    useApprovalStore.setState({ submitted: {}, transport: null });
    useApprovalStore.getState().bindTransport((m) => {
      if (online) sent.push(m);
      return online;
    });
  });

  it("sends TOOL_APPROVAL with a trimmed note and records the decision", () => {
    expect(
      useApprovalStore.getState().decide("c1", "reject", "  too risky "),
    ).toBe(true);
    expect(sent).toEqual([
      {
        type: "TOOL_APPROVAL",
        callId: "c1",
        decision: "reject",
        reason: "too risky",
      },
    ]);
    expect(useApprovalStore.getState().submitted).toEqual({ c1: "reject" });
  });

  it("omits an empty note", () => {
    useApprovalStore.getState().decide("c1", "approve", "   ");
    expect(sent).toEqual([
      { type: "TOOL_APPROVAL", callId: "c1", decision: "approve" },
    ]);
  });

  it("does not send twice for the same call", () => {
    const { decide } = useApprovalStore.getState();
    decide("c1", "approve");
    expect(decide("c1", "reject")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("does not record a decision that could not be sent", () => {
    online = false;
    expect(useApprovalStore.getState().decide("c1", "approve")).toBe(false);
    expect(useApprovalStore.getState().submitted).toEqual({});
    useApprovalStore.getState().bindTransport(null);
    expect(useApprovalStore.getState().decide("c1", "approve")).toBe(false);
  });

  it("settle and clearSubmitted forget decisions", () => {
    const s = useApprovalStore.getState();
    s.decide("c1", "approve");
    s.decide("c2", "reject");
    s.settle("c1");
    expect(useApprovalStore.getState().submitted).toEqual({ c2: "reject" });
    const before = useApprovalStore.getState().submitted;
    useApprovalStore.getState().settle("unknown");
    expect(useApprovalStore.getState().submitted).toBe(before);
    useApprovalStore.getState().clearSubmitted();
    expect(useApprovalStore.getState().submitted).toEqual({});
    // Re-sending after a reconnect is allowed.
    expect(useApprovalStore.getState().decide("c2", "reject")).toBe(true);
  });
});
