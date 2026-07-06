import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UsageState = "light" | "medium" | "heavy";

export interface UsageNote {
  id: string;
  text: string;
  at: number;
}

interface ClaudeUsageState {
  /** ms timestamp the rolling 5-hour session window started, or null. */
  sessionStartedAt: number | null;
  /** ms timestamp the 7-day weekly window started, or null. */
  weekStartedAt: number | null;
  /** User-estimated usage intensity (never an exact message count). */
  usageState: UsageState;
  notes: UsageNote[];
  startSession: () => void;
  endSession: () => void;
  resetWeek: () => void;
  setUsageState: (state: UsageState) => void;
  addNote: (text: string) => void;
  removeNote: (id: string) => void;
}

/**
 * Local-only Claude usage state (persisted to localStorage). The blueprint is
 * explicit that the UI must NOT promise exact remaining messages — Anthropic's
 * usage depends on message length, files, and features — so this tracks windows
 * and a user-set intensity estimate only.
 */
export const useClaudeUsage = create<ClaudeUsageState>()(
  persist(
    (set) => ({
      sessionStartedAt: null,
      weekStartedAt: null,
      usageState: "light",
      notes: [],
      startSession: () => set({ sessionStartedAt: Date.now() }),
      endSession: () => set({ sessionStartedAt: null }),
      resetWeek: () => set({ weekStartedAt: Date.now() }),
      setUsageState: (usageState) => set({ usageState }),
      addNote: (text) =>
        set((state) => ({
          notes: [
            { id: crypto.randomUUID(), text: text.trim(), at: Date.now() },
            ...state.notes,
          ].slice(0, 50),
        })),
      removeNote: (id) => set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),
    }),
    { name: "claude-usage" },
  ),
);
