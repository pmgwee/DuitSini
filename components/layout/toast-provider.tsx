"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Undo2 } from "lucide-react";

/**
 * Global, top-anchored toast — the one surface for reversible confirmations.
 *
 * Lifted out of the Music card (its original home) because a toast that lives
 * inside a card renders at the bottom of that card, buried under the fold on a
 * tall dashboard. Confirmation/undo toasts are time-sensitive: they have to
 * land in the user's focal area, which is the top of the screen just under the
 * navbar — the same place every web app that got this right (Linear, Vercel,
 * GitHub) puts them.
 *
 * Any component under <ToastProvider> can fire one via useToast().showToast().
 * Single-toast (replace-on-new) preserves the Music widget's prior semantics:
 * a rapid second like/undo replaces the first toast rather than stacking, which
 * is fine here because each toast carries its OWN undo — the action it undoes
 * is already recorded server-side, so a dismissed toast doesn't lose data.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface ToastInput {
  message: string;
  /** Primary escape hatch. Optional — absent for purely informational toasts
   *  (e.g. "sign-in renewed"), which render message-only. */
  undo?: () => void;
  /** Optional softer alternative (e.g. "Snooze instead" after a hard block). */
  alt?: ToastAction;
}

interface ToastApi {
  showToast: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  // A monotonic id per toast so React can retrigger enter transitions and the
  // auto-dismiss effect resets when one toast replaces another mid-flight.
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  const idRef = useRef(0);

  const showToast = useCallback((t: ToastInput) => {
    setToast({ ...t, id: (idRef.current += 1) });
  }, []);

  // 6s — long enough to read and reach the undo, short enough not to linger.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Memoised so consumers don't re-render every time a toast shows/dismisses
  // (showToast itself is stable; only the value object would otherwise churn).
  const value = useMemo<ToastApi>(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Viewport: fixed under the h-16 navbar, above all app chrome (sidebar
          z-40, navbar z-30). On lg it starts past the 248px sidebar so it
          centers in the content column, not over the nav. pointer-events-none
          on the wrapper so the empty area never blocks clicks; the toast itself
          re-enables them. */}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4 print:hidden lg:left-62">
        {toast && (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className="pointer-events-auto mt-3 flex w-full max-w-md items-center gap-2 rounded-xl border border-border/60 bg-surface-2 px-3 py-2 text-xs shadow-lg"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{toast.message}</span>
            {toast.alt && (
              <button
                type="button"
                onClick={() => {
                  toast.alt!.run();
                  setToast(null);
                }}
                className="shrink-0 rounded-lg px-2 py-1 font-medium text-muted-foreground hover:bg-accent"
              >
                {toast.alt.label}
              </button>
            )}
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-primary hover:bg-accent"
              >
                <Undo2 className="size-3.5" />
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
