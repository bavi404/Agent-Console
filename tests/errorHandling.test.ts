import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../stores/chatStore";
import { useTimelineStore } from "../stores/timelineStore";

/** Mirrors the ERROR branch in hooks/useWebSocket.ts */
function simulateStreamError(): void {
  const chat = useChatStore.getState();
  const timeline = useTimelineStore.getState();
  const activeId = chat.activeStreamId;
  if (activeId) {
    const msg = chat.items[activeId];
    if (msg?.kind === "message") {
      timeline.syncMessage({
        id: activeId,
        tokenCount: msg.tokenCount,
        text: msg.text,
        streaming: false,
      });
    }
  }
  chat.failActive();
}

describe("ERROR handling — chat/timeline consistency", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useTimelineStore.getState().reset();
  });

  it("stops the timeline row from streaming when the active message errors", () => {
    useChatStore.getState().applyToken({
      messageId: "m1",
      role: "assistant",
      token: "partial ",
      index: 0,
    });
    useTimelineStore.getState().ensureMessage({
      id: "m1",
      role: "assistant",
      seq: 1,
    });
    useTimelineStore.getState().syncMessage({
      id: "m1",
      tokenCount: 1,
      text: "partial ",
      streaming: true,
    });

    simulateStreamError();

    const chatMsg = useChatStore.getState().items["m1"];
    const timelineMsg = useTimelineStore.getState().items["m1"];
    expect(chatMsg?.kind).toBe("message");
    if (chatMsg?.kind !== "message") return;
    expect(chatMsg.status).toBe("error");
    expect(timelineMsg?.kind).toBe("message");
    if (timelineMsg?.kind !== "message") return;
    expect(timelineMsg.streaming).toBe(false);
    expect(timelineMsg.text).toBe("partial ");
  });
});
