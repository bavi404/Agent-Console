import { describe, it, expect } from "vitest";
import {
  emptyTranscript,
  applyToken,
  endStream,
  addToolCall,
  acknowledgeToolCall,
  runToolCall,
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

describe("tool cards — lifecycle", () => {
  it("walks pending -> acknowledged -> running -> completed", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "Let me "));

    s = addToolCall(s, { callId: "c1", name: "search", args: { q: 1 }, now: 0 });
    expect(card(s, "c1").status).toBe("pending");
    expect(msg(s, "m1").status).toBe("paused"); // message frozen

    s = acknowledgeToolCall(s, "c1");
    expect(card(s, "c1").status).toBe("acknowledged");

    s = runToolCall(s, "c1");
    expect(card(s, "c1").status).toBe("running");

    s = completeToolCall(s, {
      callId: "c1",
      ok: true,
      result: { hits: 2 },
      durationMs: 50,
    });
    expect(card(s, "c1").status).toBe("completed");
    expect(card(s, "c1").result).toEqual({ hits: 2 });
    expect(msg(s, "m1").status).toBe("streaming"); // stream resumed
  });

  it("transitions to error on a failed result and still resumes", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "hi"));
    s = addToolCall(s, { callId: "c1", name: "f", args: null, now: 0 });
    s = runToolCall(s, "c1");
    s = completeToolCall(s, {
      callId: "c1",
      ok: false,
      error: "boom",
      durationMs: 10,
    });
    expect(card(s, "c1").status).toBe("error");
    expect(card(s, "c1").error).toBe("boom");
    expect(msg(s, "m1").status).toBe("streaming");
  });

  it("ignores out-of-lifecycle transitions", () => {
    let s = emptyTranscript();
    s = addToolCall(s, { callId: "c1", name: "f", args: 1, now: 0 });
    s = completeToolCall(s, { callId: "c1", ok: true, durationMs: 5 });
    expect(card(s, "c1").status).toBe("completed");
    const ref = s;
    // ack/run after completion are no-ops
    s = acknowledgeToolCall(s, "c1");
    s = runToolCall(s, "c1");
    expect(s).toBe(ref);
    expect(card(s, "c1").status).toBe("completed");
  });
});

describe("tool cards — freeze / resume from exact character", () => {
  it("resumes streaming from the exact character after a tool call", () => {
    let s = emptyTranscript();
    s = applyToken(s, tok("m1", 0, "Let me "));
    s = applyToken(s, tok("m1", 1, "check "));

    s = addToolCall(s, { callId: "c1", name: "search", args: {}, now: 0 });
    s = runToolCall(s, "c1");
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
    s = runToolCall(s, "c1");
    s = completeToolCall(s, { callId: "c1", ok: true, result: "r1", durationMs: 1 });
    s = applyToken(s, tok("m1", 1, "b"));

    s = addToolCall(s, { callId: "c2", name: "fetch", args: 2, now: 0 });
    s = runToolCall(s, "c2");
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
    s = runToolCall(s, "c1");
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
