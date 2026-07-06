import { create } from "zustand";
import type { ChatRole } from "@/protocol/types";
import {
  acknowledgeToolCall,
  addLocalMessage,
  addToolCall,
  applyToken,
  completeToolCall,
  emptyTranscript,
  endStream,
  failActiveStream,
  runToolCall,
  type TranscriptState,
} from "@/lib/streaming";

export type {
  ChatMessage,
  ToolCard,
  ToolCardStatus,
  TranscriptItem,
  StreamStatus,
} from "@/lib/streaming";

interface ChatActions {
  applyToken: (event: {
    messageId: string;
    role: ChatRole;
    token: string;
    index: number;
  }) => void;
  endStream: (event: { messageId: string }) => void;
  addToolCall: (event: { callId: string; name: string; args: unknown }) => void;
  acknowledgeToolCall: (callId: string) => void;
  runToolCall: (callId: string) => void;
  completeToolCall: (event: {
    callId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }) => void;
  failActive: () => void;
  appendLocal: (text: string) => string;
  reset: () => void;
}

type ChatState = TranscriptState & ChatActions;

const localId = (): string =>
  `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useChatStore = create<ChatState>((set) => ({
  ...emptyTranscript(),

  applyToken: (event) =>
    set((state) => applyToken(state, { ...event, now: Date.now() })),

  endStream: ({ messageId }) => set((state) => endStream(state, messageId)),

  addToolCall: (event) =>
    set((state) => addToolCall(state, { ...event, now: Date.now() })),

  acknowledgeToolCall: (callId) =>
    set((state) => acknowledgeToolCall(state, callId)),

  runToolCall: (callId) => set((state) => runToolCall(state, callId)),

  completeToolCall: (event) => set((state) => completeToolCall(state, event)),

  failActive: () => set((state) => failActiveStream(state)),

  appendLocal: (text) => {
    const id = localId();
    set((state) => addLocalMessage(state, { id, text, now: Date.now() }));
    return id;
  },

  reset: () => set(emptyTranscript()),
}));
