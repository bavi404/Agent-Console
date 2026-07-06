import { create } from "zustand";

/**
 * Cross-panel selection. Chat messages, timeline rows and tool cards all share
 * the same id space (messageId / callId), so a single selected id links the
 * views:
 *   - Click a timeline row  -> `select(id)`  -> chat highlights & reveals it.
 *   - Click a chat message  -> `focus(id)`   -> timeline highlights & scrolls.
 *
 * `scrollNonce` bumps on every focus so the timeline scrolls again even when
 * the same id is re-focused.
 */
interface SelectionState {
  selectedId: string | null;
  /** Set by chat clicks; consumed by the timeline to scroll into view. */
  scrollTarget: string | null;
  scrollNonce: number;
  select: (id: string | null) => void;
  focus: (id: string) => void;
  clearScrollTarget: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedId: null,
  scrollTarget: null,
  scrollNonce: 0,

  select: (id) => set({ selectedId: id }),

  focus: (id) =>
    set((state) => ({
      selectedId: id,
      scrollTarget: id,
      scrollNonce: state.scrollNonce + 1,
    })),

  clearScrollTarget: () => set({ scrollTarget: null }),
}));
