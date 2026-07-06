import { create } from "zustand";
import type { WsSnapshot, WsState } from "@/protocol/stateMachine";
import type { ParseError } from "@/protocol/types";
import type { MalformedHeartbeat } from "@/protocol/heartbeatManager";
import type { SkippedGap } from "@/protocol/reorderBuffer";

interface WebSocketState {
  connection: WsState;
  attempt: number;
  /** Wall-clock ms until the next reconnect attempt, if scheduled. */
  retryInMs: number | null;
  /** When Reconnecting/Resuming began (for the reconnect indicator). */
  reconnectingSince: number | null;
  skips: SkippedGap[];
  parseErrors: number;
  heartbeatMalformed: number;
  lastHeartbeatMalformed: MalformedHeartbeat | null;
  lastParseError: ParseError | null;
  messagesDelivered: number;
  /** Sequence number of the most recently delivered, in-order message. */
  currentSeq: number;
  /** Most recent server-reported ERROR event. */
  lastError: { code: string; message: string; fatal: boolean } | null;

  setSnapshot: (snap: WsSnapshot) => void;
  setRetryIn: (ms: number | null) => void;
  recordSkip: (skip: SkippedGap) => void;
  recordParseError: (error: ParseError) => void;
  recordHeartbeatMalformed: (detail: MalformedHeartbeat) => void;
  recordError: (error: {
    code: string;
    message: string;
    fatal: boolean;
  }) => void;
  /** Transport watermark — includes PING and every processed frame. */
  setLastProcessedSeq: (seq: number) => void;
  /** Logical app events only (not TOKEN bursts). */
  recordAppMessage: (seq: number) => void;
  /** Clear per-connection diagnostic noise after a successful session. */
  resetSessionDiagnostics: () => void;
}

export const useWebSocketStore = create<WebSocketState>((set) => ({
  connection: "Disconnected",
  attempt: 0,
  retryInMs: null,
  reconnectingSince: null,
  skips: [],
  parseErrors: 0,
  heartbeatMalformed: 0,
  lastHeartbeatMalformed: null,
  lastParseError: null,
  messagesDelivered: 0,
  currentSeq: 0,
  lastError: null,

  setSnapshot: (snap) =>
    set((state) => {
      const reconnecting =
        snap.state === "Reconnecting" || snap.state === "Resuming";
      return {
        connection: snap.state,
        attempt: snap.attempt,
        reconnectingSince: reconnecting
          ? (state.reconnectingSince ?? Date.now())
          : null,
      };
    }),
  setRetryIn: (ms) => set({ retryInMs: ms }),
  recordSkip: (skip) =>
    set((state) => ({ skips: [...state.skips, skip].slice(-50) })),
  recordParseError: (error) =>
    set((state) => ({
      parseErrors: state.parseErrors + 1,
      lastParseError: error,
    })),
  recordHeartbeatMalformed: (detail) =>
    set((state) => ({
      heartbeatMalformed: state.heartbeatMalformed + 1,
      lastHeartbeatMalformed: detail,
    })),
  recordError: (error) => set({ lastError: error }),
  setLastProcessedSeq: (seq) => set({ currentSeq: seq }),
  recordAppMessage: (seq) =>
    set((state) => ({
      messagesDelivered: state.messagesDelivered + 1,
      currentSeq: Math.max(state.currentSeq, seq),
    })),
  resetSessionDiagnostics: () =>
    set({
      parseErrors: 0,
      heartbeatMalformed: 0,
      lastParseError: null,
      lastHeartbeatMalformed: null,
    }),
}));
