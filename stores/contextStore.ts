import { create } from "zustand";
import type { ContextSnapshotEvent, JsonObject } from "@/protocol/types";

export interface ContextSnapshot {
  revision: number;
  /** Server sequence number — used to ignore RESUME replays. */
  seq: number;
  context: JsonObject;
  ts: number;
}

const HISTORY_LIMIT = 50;

function hasRevision(history: ContextSnapshot[], rev: number | null): boolean {
  return rev !== null && history.some((entry) => entry.revision === rev);
}

interface ContextState {
  /** Bounded snapshot history, oldest first. */
  history: ContextSnapshot[];
  /** Revision currently being inspected (null until the first snapshot). */
  currentRev: number | null;
  /** Revision to diff against (null = no baseline). */
  baselineRev: number | null;
  /** When true, `currentRev` tracks the newest snapshot as it arrives. */
  follow: boolean;

  applySnapshot: (event: Pick<ContextSnapshotEvent, "context" | "seq">) => void;
  setCurrentRev: (rev: number) => void;
  setBaselineRev: (rev: number | null) => void;
  setFollow: (follow: boolean) => void;
  reset: () => void;
}

export const useContextStore = create<ContextState>((set) => ({
  history: [],
  currentRev: null,
  baselineRev: null,
  follow: true,

  applySnapshot: ({ context, seq }) =>
    set((state) => {
      if (state.history.some((entry) => entry.seq === seq)) return state;

      const last = state.history[state.history.length - 1];
      const revision = (last?.revision ?? 0) + 1;
      const snapshot: ContextSnapshot = {
        revision,
        seq,
        context,
        ts: Date.now(),
      };
      const history = [...state.history, snapshot].slice(-HISTORY_LIMIT);

      if (!state.follow) {
        const fallback = history[0]?.revision ?? null;
        const currentRev = hasRevision(history, state.currentRev)
          ? state.currentRev
          : fallback;
        const baselineRev = hasRevision(history, state.baselineRev)
          ? state.baselineRev
          : null;
        return { history, currentRev, baselineRev };
      }
      // Following: inspect the newest, compare against the one before it.
      return {
        history,
        currentRev: revision,
        baselineRev: last ? last.revision : null,
      };
    }),

  setCurrentRev: (rev) =>
    set((state) => {
      const idx = state.history.findIndex((s) => s.revision === rev);
      const baselineRev = idx > 0 ? state.history[idx - 1]!.revision : null;
      const newest = state.history[state.history.length - 1];
      return {
        currentRev: rev,
        baselineRev,
        follow: newest ? rev === newest.revision : false,
      };
    }),

  setBaselineRev: (rev) => set({ baselineRev: rev }),
  setFollow: (follow) => set({ follow }),

  reset: () =>
    set({ history: [], currentRev: null, baselineRev: null, follow: true }),
}));
