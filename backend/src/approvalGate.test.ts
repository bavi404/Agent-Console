import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalGate, type GateTimers } from "./approvalGate.js";

/** Manual timers: `fire()` runs every scheduled callback that wasn't cleared. */
function manualTimers(): GateTimers & { fire: () => void; live: () => number } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    set(fn) {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clear(handle) {
      timers.delete(handle as number);
    },
    fire() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    live: () => timers.size,
  };
}

describe("ApprovalGate", () => {
  it("resolves approved with a trimmed note and clears its timer", async () => {
    const timers = manualTimers();
    const gate = new ApprovalGate(timers);
    const pending = gate.request("c1", 1000);
    assert.equal(gate.isPending("c1"), true);
    assert.equal(gate.decide("c1", "approve", "  go ahead "), true);
    assert.deepEqual(await pending, { outcome: "approved", note: "go ahead" });
    assert.equal(gate.size, 0);
    assert.equal(timers.live(), 0);
  });

  it("first decision wins; later and unknown decisions are ignored", async () => {
    const gate = new ApprovalGate(manualTimers());
    const pending = gate.request("c1", 1000);
    assert.equal(gate.decide("c1", "reject"), true);
    assert.equal(gate.decide("c1", "approve"), false);
    assert.equal(gate.decide("nope", "approve"), false);
    assert.deepEqual(await pending, { outcome: "rejected" });
  });

  it("expires when the timer fires, after which decisions are ignored", async () => {
    const timers = manualTimers();
    const gate = new ApprovalGate(timers);
    const pending = gate.request("c1", 1000);
    timers.fire();
    assert.deepEqual(await pending, { outcome: "expired" });
    assert.equal(gate.decide("c1", "approve"), false);
  });

  it("cancelAll settles every pending request", async () => {
    const timers = manualTimers();
    const gate = new ApprovalGate(timers);
    const a = gate.request("a", 1000);
    const b = gate.request("b", 1000);
    gate.cancelAll("bye");
    assert.deepEqual(await a, { outcome: "cancelled", reason: "bye" });
    assert.deepEqual(await b, { outcome: "cancelled", reason: "bye" });
    assert.equal(timers.live(), 0);
  });

  it("rejects a duplicate request for a pending call", async () => {
    const gate = new ApprovalGate(manualTimers());
    void gate.request("c1", 1000);
    await assert.rejects(gate.request("c1", 1000), /already pending/);
  });
});
