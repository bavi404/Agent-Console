import { create } from "zustand";
import type { ClientMessage } from "@/protocol/types";
import type { ToolDecision } from "@/protocol/toolStatus";

/**
 * Human-approval intents (client side only).
 *
 * The transcript (chatStore) holds server truth: a tool stays
 * "awaiting_approval" until the server echoes the decision back as a
 * TOOL_STATUS. This store holds the gap in between — decisions the user has
 * sent but the server has not confirmed yet — so the UI can disable the
 * buttons and show "sending…" without inventing a status.
 *
 * The transport is bound by useWebSocket, so any component can submit a
 * decision without prop-drilling `send` through the virtualized lists.
 */

type Transport = (message: ClientMessage) => boolean;

interface ApprovalState {
  /** callId -> decision sent but not yet confirmed by the server. */
  submitted: Record<string, ToolDecision>;
  transport: Transport | null;

  bindTransport: (transport: Transport | null) => void;
  /** Send a decision. Returns false if not connected or already submitted. */
  decide: (callId: string, decision: ToolDecision, reason?: string) => boolean;
  /** The server confirmed (the call left awaiting_approval). */
  settle: (callId: string) => void;
  /** Forget unconfirmed decisions (e.g. after reconnect) so they can be re-sent. */
  clearSubmitted: () => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  submitted: {},
  transport: null,

  bindTransport: (transport) => set({ transport }),

  decide: (callId, decision, reason) => {
    const { transport, submitted } = get();
    if (!transport || submitted[callId]) return false;
    const note = reason?.trim();
    const sent = transport({
      type: "TOOL_APPROVAL",
      callId,
      decision,
      ...(note ? { reason: note } : {}),
    });
    if (sent) {
      set((state) => ({
        submitted: { ...state.submitted, [callId]: decision },
      }));
    }
    return sent;
  },

  settle: (callId) =>
    set((state) => {
      if (!(callId in state.submitted)) return state;
      const { [callId]: _settled, ...rest } = state.submitted;
      void _settled;
      return { submitted: rest };
    }),

  clearSubmitted: () =>
    set((state) =>
      Object.keys(state.submitted).length === 0 ? state : { submitted: {} },
    ),
}));
