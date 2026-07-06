import { describe, it, expect, beforeEach } from "vitest";
import { useContextStore } from "../stores/contextStore";

describe("contextStore — snapshot replay", () => {
  beforeEach(() => {
    useContextStore.getState().reset();
  });

  it("deduplicates snapshots by server seq on RESUME replay", () => {
    useContextStore.getState().applySnapshot({
      seq: 10,
      context: { session: "a", turns: 1 },
    });
    useContextStore.getState().applySnapshot({
      seq: 10,
      context: { session: "replay", turns: 999 },
    });

    const { history } = useContextStore.getState();
    expect(history).toHaveLength(1);
    expect(history[0]!.seq).toBe(10);
    expect(history[0]!.context).toEqual({ session: "a", turns: 1 });
  });

  it("accepts new snapshots with higher seq values", () => {
    useContextStore.getState().applySnapshot({ seq: 1, context: { v: 1 } });
    useContextStore.getState().applySnapshot({ seq: 2, context: { v: 2 } });

    expect(useContextStore.getState().history).toHaveLength(2);
    expect(useContextStore.getState().currentRev).toBe(2);
  });

  it("clamps the inspected revision when bounded history evicts it", () => {
    const store = useContextStore.getState();
    store.applySnapshot({ seq: 1, context: { v: 1 } });
    store.setCurrentRev(1);
    store.setFollow(false);

    for (let seq = 2; seq <= 51; seq += 1) {
      useContextStore.getState().applySnapshot({ seq, context: { v: seq } });
    }

    const { history, currentRev, baselineRev, follow } =
      useContextStore.getState();
    expect(history).toHaveLength(50);
    expect(history[0]!.revision).toBe(2);
    expect(currentRev).toBe(2);
    expect(baselineRev).toBeNull();
    expect(follow).toBe(false);
  });
});
