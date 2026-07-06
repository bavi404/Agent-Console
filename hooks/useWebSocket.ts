"use client";

import { useEffect, useMemo, useRef } from "react";
import { WebSocketManager } from "@/protocol/webSocketManager";
import type { WebSocketManagerOptions } from "@/protocol/webSocketManager";
import type { ClientMessage, ServerEvent } from "@/protocol/types";
import { TokenBatcher, rafScheduler } from "@/lib/tokenBatcher";
import { useChatStore } from "@/stores/chatStore";
import { useTimelineStore } from "@/stores/timelineStore";
import { useContextStore } from "@/stores/contextStore";
import { useWebSocketStore } from "@/stores/websocketStore";

/**
 * The single bridge between the (pure) WebSocketManager and React state.
 * It owns the manager lifecycle and fans its observable events out to the
 * domain stores. Reconnect timing and backoff live inside the manager, so this
 * hook holds no connection logic of its own.
 */

type Send = (message: ClientMessage) => boolean;

/** Push the latest (batched) token counts from chat into the timeline.
 *  Called once per animation frame — keeps the timeline smooth at 30+ TOKEN/s
 *  because the panel shell never re-renders per token, only the active row. */
function flushTokens(ids: ReadonlySet<string>): void {
  const chat = useChatStore.getState();
  const timeline = useTimelineStore.getState();
  for (const id of ids) {
    const node = chat.items[id];
    if (node && node.kind === "message") {
      timeline.syncMessage({
        id,
        tokenCount: node.tokenCount,
        text: node.text,
        streaming: node.status === "streaming" || node.status === "paused",
      });
    }
  }
}

/** Route one ordered, validated server event to the right store. */
function routeMessage(
  event: ServerEvent,
  send: Send,
  batcher: TokenBatcher,
): void {
  const chat = useChatStore.getState();
  const timeline = useTimelineStore.getState();
  switch (event.type) {
    case "TOKEN":
      chat.applyToken(event);
      // Create the timeline row once (keeps ordering), then batch the count.
      timeline.ensureMessage({
        id: event.messageId,
        role: event.role,
        seq: event.seq,
      });
      batcher.add(event.messageId);
      break;
    case "STREAM_END":
      chat.endStream(event);
      batcher.flush(); // land the final count before finalizing
      timeline.endMessage(event.messageId);
      break;
    case "TOOL_CALL": {
      const existing = chat.items[event.callId];
      const isNew = !existing;
      if (isNew) chat.addToolCall(event);

      const acked = send({ type: "TOOL_ACK", callId: event.callId });
      const needsLifecycle =
        isNew ||
        (existing?.kind === "tool" && existing.status === "pending");

      if (acked && needsLifecycle) {
        chat.acknowledgeToolCall(event.callId);
        chat.runToolCall(event.callId);
        batcher.flush();
        if (isNew) {
          timeline.applyToolCall({
            callId: event.callId,
            name: event.name,
            args: event.args,
            seq: event.seq,
          });
        }
      }
      break;
    }
    case "TOOL_RESULT": {
      // Idempotent: replays update the same card without resetting streams.
      chat.completeToolCall(event);
      timeline.applyToolResult({
        callId: event.callId,
        ok: event.ok,
        result: event.result,
        ...(event.error !== undefined ? { error: event.error } : {}),
        durationMs: event.durationMs,
      });
      break;
    }
    case "CONTEXT_SNAPSHOT":
      useContextStore.getState().applySnapshot(event);
      break;
    case "ERROR": {
      const activeId = chat.activeStreamId;
      batcher.flush();
      if (activeId) {
        const msg = useChatStore.getState().items[activeId];
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
      useWebSocketStore.getState().recordError(event);
      break;
    }
    case "PING":
      // Consumed inside the manager; never reaches here.
      break;
  }
}

export interface UseWebSocketResult {
  send: (text: string) => boolean;
  retryNow: () => void;
}

export function useWebSocket(
  options: WebSocketManagerOptions,
): UseWebSocketResult {
  // Build the manager once. URL / factory changes are intentionally ignored
  // after mount; remount the consumer to point at a new endpoint.
  const manager = useMemo(
    () => new WebSocketManager(options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const batcher = useMemo(
    () => new TokenBatcher(rafScheduler, flushTokens),
    [],
  );
  const managerRef = useRef(manager);
  managerRef.current = manager;

  useEffect(() => {
    const ws = useWebSocketStore.getState();

    const subscription = manager.subscribe((event) => {
      switch (event.type) {
        case "state":
          ws.setSnapshot(event.snapshot);
          if (event.snapshot.state === "Connected") {
            ws.resetSessionDiagnostics();
          }
          if (event.snapshot.state !== "Reconnecting") ws.setRetryIn(null);
          break;
        case "retry":
          ws.setRetryIn(event.delayMs);
          break;
        case "message": {
          const evt = event.event;
          routeMessage(evt, (message) => manager.send(message), batcher);
          // TOKEN arrives at 30+/sec — do not bump header metrics per token.
          if (evt.type !== "TOKEN") {
            useWebSocketStore.getState().recordAppMessage(evt.seq);
          }
          break;
        }
        case "seq":
          useWebSocketStore.getState().setLastProcessedSeq(event.lastProcessed);
          break;
        case "parseError":
          ws.recordParseError(event.error);
          break;
        case "heartbeatMalformed":
          ws.recordHeartbeatMalformed(event.detail);
          break;
        case "duplicate":
          break;
        case "seqGap":
          ws.recordSkip(event.gap);
          break;
      }
    });

    manager.connect();

    return () => {
      subscription.unsubscribe();
      batcher.flush();
      manager.close();
      batcher.dispose();
    };
  }, [manager, batcher]);

  return {
    send: (text: string) => {
      const ok = managerRef.current.send({ type: "USER_MESSAGE", text });
      if (ok) useChatStore.getState().appendLocal(text);
      return ok;
    },
    retryNow: () => managerRef.current.reconnectNow(),
  };
}
