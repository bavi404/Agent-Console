import { describe, it, expect } from "vitest";
import {
  emptyTranscript,
  applyToken,
  endStream,
  addToolCall,
  acknowledgeToolCall,
  applyToolStatus,
  completeToolCall,
  addLocalMessage,
  failActiveStream,
  type TranscriptState,
  type ChatMessage,
  type ToolCard,
} from "../lib/streaming";

const tok = (
  messageId: string,
  index: number,
  token: string,
): Parameters<typeof applyToken>[1] => ({
  messageId,
  role: "assistant",
  token,
  index,
  now: 0,
});

const msg = (state: TranscriptState, id: string): ChatMessage => {
  const item = state.items[id];
  if (!item || item.kind !== "message") throw new Error("not a message");
  return item;
};
const card = (state: TranscriptState, id: string): ToolCard => {
  const item = state.items[id];
  if (!item || item.kind !== "tool") throw new Error("not a tool");
  return item;
};

describe("streaming — token rendering", () => {
  it("creates a message on the first token and appends in order", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "Hel"));
    s = applyToken(s, tok("m1", 1, "lo"));
    s = applyToken(s, tok("m1", 2, " world"));
    expect(msg(s, "m1").text).toBe("Hello world");
    expect(msg(s, "m1").tokenCount).toBe(3);
    expect(msg(s, "m1").status).toBe("streaming");
    expect(s.activeStreamId).toBe("m1");
  });

  it("keeps each stream_id in its own message", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("a", 0, "A0"));
    s = applyToken(s, tok("b", 0, "B0"));
    s = applyToken(s, tok("a", 1, "A1"));
    expect(msg(s, "a").text).toBe("A0A1");
    expect(msg(s, "b").text).toBe("B0");
    expect(s.order).toEqual(["a", "b"]);
  });

  it("ignores a brand-new stream that does not start at index 0", () => {
    const s0 = emptyTranscript();
    const s1 = applyToken(s0, tok("m1", 3, "late"));
    expect(s1).toBe(s0); // no-op, same reference
    expect(s1.items["m1"]).toBeUndefined();
  });
});

describe("streaming — no duplicate text", () => {
  it("ignores a duplicate token (same index) without changing state", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "X"));
    const afterFirst = s;
    s = applyToken(s, tok("m1", 0, "X")); // replayed
    expect(s).toBe(afterFirst); // unchanged reference
    expect(msg(s, "m1").text).toBe("X");
    expect(msg(s, "m1").tokenCount).toBe(1);
  });

  it("ignores out-of-order future tokens (gap)", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "a"));
    const ref = s;
    s = applyToken(s, tok("m1", 2, "c")); // index 2 while expecting 1
    expect(s).toBe(ref);
    expect(msg(s, "m1").text).toBe("a");
  });

  it("survives a full replay without duplicating", () => {
    let s = emptyTranscript();
    const tokens = ["one ", "two ", "three"];
    tokens.forEach((t, i) => (s = applyToken(s, tok("m1", i, t))));
    tokens.forEach((t, i) => (s = applyToken(s, tok("m1", i, t))));
    expect(msg(s, "m1").text).toBe("one two three");
    expect(msg(s, "m1").tokenCount).toBe(3);
  });
});

const status = (
  callId: string,
  st: Parameters<typeof applyToolStatus>[1]["status"],
  extra: { detail?: string; progress?: number; name?: string; args?: unknown } = {},
): Parameters<typeof applyToolStatus>[1] => ({
  callId,
  name: extra.name ?? "search",
  args: extra.args ?? {},
  status: st,
  ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
  now: 0,
});

describe("tool cards — explicit execution status", () => {
  it("walks queued -> running -> succeeded from server events", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "Let me "));

    s = addToolCall(s, { callId: "c1", name: "search", args: { q: 1 }, now: 0 });
    expect(card(s, "c1").status).toBe("queued");
    expect(card(s, "c1").acknowledged).toBe(false);
    expect(msg(s, "m1").status).toBe("paused"); // message frozen

    s = acknowledgeToolCall(s, "c1");
    expect(card(s, "c1").acknowledged).toBe(true);
    expect(card(s, "c1").status).toBe("queued"); // ack never implies running

    s = applyToolStatus(s, status("c1", "running"));
    expect(card(s, "c1").status).toBe("running");

    s = completeToolCall(s, {
      callId: "c1",
      ok: true,
      result: { hits: 2 },
      durationMs: 50,
    });
    expect(card(s, "c1").status).toBe("succeeded");
    expect(card(s, "c1").result).toEqual({ hits: 2 });
    expect(msg(s, "m1").status).toBe("streaming"); // stream resumed
  });

  it("transitions to failed on a failed result and still resumes", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "hi"));
    s = addToolCall(s, { callId: "c1", name: "f", args: null, now: 0 });
    s = applyToolStatus(s, status("c1", "running", { name: "f" }));
    s = completeToolCall(s, {
      callId: "c1",
      ok: false,
      error: "boom",
      durationMs: 10,
    });
    expect(card(s, "c1").status).toBe("failed");
    expect(card(s, "c1").error).toBe("boom");
    expect(msg(s, "m1").status).toBe("streaming");
  });

  it("updates detail and progress while running without changing status", () => {
    let s = emptyTranscript();
    s = addToolCall(s, { callId: "c1", name: "search", args: {}, now: 0 });
    s = applyToolStatus(s, status("c1", "running", { detail: "a", progress: 0.2 }));
    s = applyToolStatus(s, status("c1", "running", { detail: "b", progress: 0.8 }));
    expect(card(s, "c1")).toMatchObject({
      status: "running",
      detail: "b",
      progress: 0.8,
    });
    const ref = s;
    s = applyToolStatus(s, status("c1", "running", { detail: "b", progress: 0.8 }));
    expect(s).toBe(ref); // exact duplicate is a no-op
  });

  it("clamps out-of-range progress", () => {
    let s = emptyTranscript();
    s = applyToolStatus(s, status("c1", "running", { progress: 7 }));
    expect(card(s, "c1").progress).toBe(1);
  });

  it("never regresses: late or replayed statuses are ignored", () => {
    let s = emptyTranscript();
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = completeToolCall(s, { callId: "c1", ok: true, durationMs: 5 });
    expect(card(s, "c1").status).toBe("succeeded");
    const ref = s;
    s = applyToolStatus(s, status("c1", "running", { name: "f" }));
    s = applyToolStatus(s, status("c1", "queued", { name: "f" }));
    s = applyToolStatus(s, status("c1", "cancelled", { name: "f" }));
    expect(s).toBe(ref);
    expect(card(s, "c1").status).toBe("succeeded");
  });

  it("creates a card from a self-describing TOOL_STATUS with no prior TOOL_CALL", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "x"));
    s = applyToolStatus(
      s,
      status("c9", "running", { name: "wiki", args: { query: "Ada" } }),
    );
    expect(card(s, "c9")).toMatchObject({
      name: "wiki",
      args: { query: "Ada" },
      status: "running",
      acknowledged: false,
    });
    expect(msg(s, "m1").status).toBe("paused");
    // A late TOOL_CALL for the same id does not reset it.
    const ref = s;
    s = addToolCall(s, { callId: "c9", name: "wiki", args: {}, now: 0 });
    expect(s).toBe(ref);
  });

  it("cancellation is terminal: resumes the stream and ignores a later result", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "x"));
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = applyToolStatus(s, status("c1", "cancelled", { name: "f", detail: "limit" }));
    expect(card(s, "c1").status).toBe("cancelled");
    expect(card(s, "c1").detail).toBe("limit");
    expect(msg(s, "m1").status).toBe("streaming");
    const ref = s;
    s = completeToolCall(s, { callId: "c1", ok: true, result: 1, durationMs: 1 });
    expect(s).toBe(ref);
  });

  it("a terminal TOOL_STATUS keeps its status when TOOL_RESULT attaches data", () => {
    let s = emptyTranscript();
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = applyToolStatus(s, status("c1", "failed", { name: "f" }));
    s = completeToolCall(s, { callId: "c1", ok: false, error: "e", durationMs: 3 });
    expect(card(s, "c1")).toMatchObject({ status: "failed", error: "e", durationMs: 3 });
    const ref = s;
    s = completeToolCall(s, { callId: "c1", ok: true, durationMs: 9 }); // replay
    expect(s).toBe(ref);
  });

  it("keeps the stream frozen until every queued tool has finished", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "x"));
    s = addToolCall(s, { callId: "c1", name: "a", args: 1, now: 0 });
    s = addToolCall(s, { callId: "c2", name: "b", args: 2, now: 0 });
    s = completeToolCall(s, { callId: "c1", ok: true, durationMs: 1 });
    expect(msg(s, "m1").status).toBe("paused"); // c2 still queued
    s = completeToolCall(s, { callId: "c2", ok: true, durationMs: 1 });
    expect(msg(s, "m1").status).toBe("streaming");
  });

  it("acknowledge is idempotent and ignores unknown ids", () => {
    let s = emptyTranscript();
    expect(acknowledgeToolCall(s, "nope")).toBe(s);
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = acknowledgeToolCall(s, "c1");
    expect(acknowledgeToolCall(s, "c1")).toBe(s);
  });

  it("ignores TOOL_STATUS whose callId collides with a message id", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "x"));
    expect(applyToolStatus(s, status("m1", "running"))).toBe(s);
  });
});

describe("tool cards — freeze / resume from exact character", () => {
  it("resumes streaming from the exact character after a tool call", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "Let me "));
    s = applyToken(s, tok("m1", 1, "check "));

    s = addToolCall(s, { callId: "c1", name: "search", args: {}, now: 0 });
    s = applyToolStatus(s, status("c1", "running"));
    s = completeToolCall(s, { callId: "c1", ok: true, durationMs: 1 });

    s = applyToken(s, tok("m1", 2, "the weather."));
    expect(msg(s, "m1").text).toBe("Let me check the weather.");
    expect(msg(s, "m1").tokenCount).toBe(3);
  });
});

describe("tool cards — multiple sequential calls never overwrite", () => {
  it("keeps a separate card per callId and updates the right one", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "a"));

    s = addToolCall(s, { callId: "c1", name: "search", args: 1, now: 0 });
    s = applyToolStatus(s, status("c1", "running"));
    s = completeToolCall(s, { callId: "c1", ok: true, result: "r1", durationMs: 1 });
    s = applyToken(s, tok("m1", 1, "b"));

    s = addToolCall(s, { callId: "c2", name: "fetch", args: 2, now: 0 });
    s = applyToolStatus(s, status("c2", "running", { name: "fetch" }));
    s = completeToolCall(s, { callId: "c2", ok: true, result: "r2", durationMs: 1 });
    s = applyToken(s, tok("m1", 2, "c"));

    expect(s.order).toEqual(["m1", "c1", "c2"]);
    expect(card(s, "c1").result).toBe("r1");
    expect(card(s, "c2").result).toBe("r2");
    expect(card(s, "c1").name).toBe("search");
    expect(card(s, "c2").name).toBe("fetch");
    expect(msg(s, "m1").text).toBe("abc");
  });

  it("dedupes a replayed tool call without overwriting state", () => {
    let s = emptyTranscript();
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = applyToolStatus(s, status("c1", "running", { name: "f" }));
    const ref = s;
    s = addToolCall(s, { callId: "c1", name: "DIFFERENT", args: 999, now: 9 });
    expect(s).toBe(ref); // unchanged; running card preserved
    expect(card(s, "c1").status).toBe("running");
    expect(card(s, "c1").name).toBe("f");
  });
});

describe("streaming — lifecycle & immutability", () => {
  it("completes a stream and clears the active id", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "done"));
    s = endStream(s, "m1");
    expect(msg(s, "m1").status).toBe("complete");
    expect(s.activeStreamId).toBeNull();
  });

  it("failActiveStream marks the active message errored", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "partial"));
    s = failActiveStream(s);
    expect(msg(s, "m1").status).toBe("error");
    s = endStream(s, "m1"); // stays errored
    expect(msg(s, "m1").status).toBe("error");
  });

  it("appends completed local messages", () => {
    let s = emptyTranscript();
    s = addLocalMessage(s, { id: "u1", text: "hello agent", now: 0 });
    expect(msg(s, "u1").role).toBe("user");
    expect(msg(s, "u1").status).toBe("complete");
  });

  it("never mutates the input state", () => {
    const s0 = emptyTranscript();
    const s1 = applyToken(s0, tok("m1", 0, "a"));
    expect(s0.items).toEqual({});
    expect(s0.order).toEqual([]);
    expect(s1).not.toBe(s0);
    expect(s1.items).not.toBe(s0.items);

    const s2 = applyToken(s1, tok("m1", 1, "b"));
    expect(msg(s1, "m1").text).toBe("a"); // s1 untouched
    expect(msg(s2, "m1").text).toBe("ab");
  });
});
