import { beforeEach, describe, expect, it } from "vitest";
import {
  TOOL_STATUSES,
  canAdvanceToolStatus,
  mergeToolStatus,
  shouldApplyToolStatus,
  isInFlightToolStatus,
  isNotExecutedToolStatus,
  isTerminalToolStatus,
  isToolStatus,
  normalizeProgress,
  toolStatusFromResult,
  type ToolStatus,
} from "../protocol/toolStatus";
import { parseFrame } from "../protocol/parser";
import { isToolStatusEvent } from "../protocol/types";
import { useTimelineStore, type ToolNode } from "../stores/timelineStore";

describe("toolStatus — lifecycle rules", () => {
  it("narrows wire values", () => {
    for (const s of TOOL_STATUSES) expect(isToolStatus(s)).toBe(true);
    expect(isToolStatus("completed")).toBe(false);
    expect(isToolStatus(1)).toBe(false);
  });

  it("classifies terminal vs in-flight", () => {
    const terminal: ToolStatus[] = [
      "succeeded",
      "failed",
      "cancelled",
      "denied",
    ];
    for (const s of TOOL_STATUSES) {
      expect(isTerminalToolStatus(s)).toBe(terminal.includes(s));
      expect(isInFlightToolStatus(s)).toBe(!terminal.includes(s));
      expect(isNotExecutedToolStatus(s)).toBe(
        s === "cancelled" || s === "denied",
      );
    }
  });

  it("only allows strictly forward transitions", () => {
    expect(canAdvanceToolStatus("queued", "running")).toBe(true);
    expect(canAdvanceToolStatus("queued", "cancelled")).toBe(true);
    expect(canAdvanceToolStatus("running", "succeeded")).toBe(true);
    expect(canAdvanceToolStatus("running", "queued")).toBe(false);
    expect(canAdvanceToolStatus("running", "running")).toBe(false);
    expect(canAdvanceToolStatus("succeeded", "failed")).toBe(false);
    expect(canAdvanceToolStatus("cancelled", "succeeded")).toBe(false);
    expect(canAdvanceToolStatus("queued", "denied")).toBe(true);
    expect(canAdvanceToolStatus("denied", "running")).toBe(false);
  });

  it("maps results and normalizes progress", () => {
    expect(toolStatusFromResult(true)).toBe("succeeded");
    expect(toolStatusFromResult(false)).toBe("failed");
    expect(normalizeProgress(0.5)).toBe(0.5);
    expect(normalizeProgress(-1)).toBe(0);
    expect(normalizeProgress(2)).toBe(1);
    expect(normalizeProgress(Number.NaN)).toBeUndefined();
    expect(normalizeProgress("0.5")).toBeUndefined();
  });
});

describe("toolStatus — update helpers", () => {
  it("accepts forward moves and progress ticks, rejects the rest", () => {
    const running = { status: "running" as const, detail: "a", progress: 0.5 };
    expect(shouldApplyToolStatus(running, { status: "succeeded" })).toBe(true);
    expect(
      shouldApplyToolStatus(running, {
        status: "running",
        detail: "b",
        progress: 0.5,
      }),
    ).toBe(true);
    expect(
      shouldApplyToolStatus(running, {
        status: "running",
        detail: "a",
        progress: 0.6,
      }),
    ).toBe(true);
    expect(
      shouldApplyToolStatus(running, {
        status: "running",
        detail: "a",
        progress: 0.5,
      }),
    ).toBe(false);
    expect(shouldApplyToolStatus(running, { status: "queued" })).toBe(false);
    expect(
      shouldApplyToolStatus(
        { status: "failed" },
        { status: "failed", detail: "x" },
      ),
    ).toBe(false);
  });

  it("merges status, clears stale notes, and normalizes progress", () => {
    const node = {
      id: "c1",
      status: "running" as ToolStatus,
      detail: "old",
      progress: 0.4,
    };
    expect(mergeToolStatus(node, { status: "cancelled" })).toEqual({
      id: "c1",
      status: "cancelled",
    });
    expect(
      mergeToolStatus(node, { status: "running", detail: "new", progress: 3 }),
    ).toEqual({
      id: "c1",
      status: "running",
      detail: "new",
      progress: 1,
    });
    expect(node.detail).toBe("old"); // input untouched
    const denied = mergeToolStatus(node, {
      status: "denied",
      detail: "not allowed",
      policyRule: "tool-access",
    });
    expect(denied).toEqual({
      id: "c1",
      status: "denied",
      detail: "not allowed",
      policyRule: "tool-access",
    });
  });
});

describe("parseFrame — TOOL_STATUS", () => {
  const base = {
    v: 1,
    seq: 1,
    ts: 0,
    type: "TOOL_STATUS",
    callId: "c1",
    name: "wikipedia_lookup",
    args: { query: "Ada" },
    status: "running",
  };
  const parse = (o: Record<string, unknown>) => parseFrame(JSON.stringify(o));

  it("accepts a minimal and a full frame", () => {
    const minimal = parse(base);
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(isToolStatusEvent(minimal.event)).toBe(true);
    }
    const full = parse({ ...base, detail: "Fetching", progress: 0.4 });
    expect(full.ok && full.event).toMatchObject({
      name: "wikipedia_lookup",
      args: { query: "Ada" },
      status: "running",
      detail: "Fetching",
      progress: 0.4,
    });
  });

  it.each([
    ["callId", { callId: 1 }],
    ["name", { name: undefined }],
    ["status", { status: "completed" }],
    ["detail", { detail: 5 }],
    ["progress", { progress: 1.5 }],
    ["progress", { progress: "half" }],
    ["policyRule", { status: "denied", policyRule: 42 }],
  ])("rejects a bad %s", (field, patch) => {
    expect(parse({ ...base, ...patch })).toEqual({
      ok: false,
      error: { code: "missing_field", detail: field },
    });
  });

  it("accepts a denied frame with its policy rule", () => {
    const denied = parse({
      ...base,
      status: "denied",
      detail: "Tool is disabled by policy.",
      policyRule: "tool-access",
    });
    expect(denied.ok && denied.event).toMatchObject({
      status: "denied",
      policyRule: "tool-access",
    });
  });

  it("requires args to be present (null is allowed)", () => {
    const noArgs: Record<string, unknown> = { ...base };
    delete noArgs.args;
    expect(parse(noArgs)).toEqual({
      ok: false,
      error: { code: "missing_field", detail: "args" },
    });
    expect(parse({ ...base, args: null }).ok).toBe(true);
  });
});

describe("timelineStore — tool status", () => {
  const tool = (id: string): ToolNode => {
    const item = useTimelineStore.getState().items[id];
    if (!item || item.kind !== "tool") throw new Error("not a tool");
    return item;
  };
  const input = (status: ToolStatus, extra: Record<string, unknown> = {}) => ({
    callId: "c1",
    name: "wikipedia_lookup",
    args: { query: "Ada" },
    status,
    seq: 2,
    ...extra,
  });

  beforeEach(() => useTimelineStore.getState().reset());

  it("starts queued and advances on explicit status", () => {
    const t = useTimelineStore.getState();
    t.applyToolCall({
      callId: "c1",
      name: "wikipedia_lookup",
      args: {},
      seq: 1,
    });
    expect(tool("c1").status).toBe("queued");
    t.applyToolStatus(
      input("running", { detail: "Searching", progress: 0.25 }),
    );
    expect(tool("c1")).toMatchObject({
      status: "running",
      detail: "Searching",
      progress: 0.25,
    });
    expect(useTimelineStore.getState().index.c1?.text).toContain("running");
  });

  it("progress ticks leave structural state untouched", () => {
    const t = useTimelineStore.getState();
    t.applyToolStatus(input("running", { progress: 0.1 }));
    const { order, index } = useTimelineStore.getState();
    t.applyToolStatus(input("running", { progress: 0.9 }));
    expect(useTimelineStore.getState().order).toBe(order);
    expect(useTimelineStore.getState().index).toBe(index);
    expect(tool("c1").progress).toBe(0.9);
  });

  it("creates a node from a self-describing status and never regresses", () => {
    const t = useTimelineStore.getState();
    t.applyToolStatus(input("cancelled", { detail: "limit" }));
    expect(useTimelineStore.getState().order).toEqual(["c1"]);
    expect(tool("c1")).toMatchObject({
      name: "wikipedia_lookup",
      status: "cancelled",
    });
    const before = useTimelineStore.getState().items;
    t.applyToolStatus(input("running"));
    t.applyToolResult({ callId: "c1", ok: true, result: 1, durationMs: 1 });
    expect(useTimelineStore.getState().items).toBe(before);
  });

  it("records denials with their rule and makes them searchable", () => {
    const t = useTimelineStore.getState();
    t.applyToolCall({ callId: "c1", name: "shell_exec", args: {}, seq: 1 });
    t.applyToolStatus(
      input("denied", {
        name: "shell_exec",
        detail: "Not on the allowlist",
        policyRule: "tool-access",
      }),
    );
    expect(tool("c1")).toMatchObject({
      status: "denied",
      policyRule: "tool-access",
      detail: "Not on the allowlist",
    });
    const text = useTimelineStore.getState().index.c1?.text ?? "";
    expect(text).toContain("denied");
    expect(text).toContain("tool-access");
    expect(text).toContain("allowlist");
    const before = useTimelineStore.getState().items;
    t.applyToolResult({ callId: "c1", ok: true, durationMs: 1 });
    expect(useTimelineStore.getState().items).toBe(before);
  });

  it("maps TOOL_RESULT onto succeeded / failed and is idempotent", () => {
    const t = useTimelineStore.getState();
    t.applyToolCall({ callId: "c1", name: "calc", args: {}, seq: 1 });
    t.applyToolResult({
      callId: "c1",
      ok: false,
      error: "nope",
      durationMs: 4,
    });
    expect(tool("c1")).toMatchObject({ status: "failed", error: "nope" });
    expect(useTimelineStore.getState().index.c1?.text).toContain("nope");
    const before = useTimelineStore.getState().items;
    t.applyToolResult({ callId: "c1", ok: true, durationMs: 9 });
    expect(useTimelineStore.getState().items).toBe(before);
  });
});
