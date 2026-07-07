"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently-open dialogs (most recently opened last). Esc only
 * dismisses the TOPMOST one, so a dialog opened from inside another (e.g. the
 * Edit/Add forms nested inside the calendar day modal) closes on Esc without
 * also dismissing the dialog beneath it. Each instance pushes an entry on open
 * and removes it on close/unmount.
 */
const openStack: Array<{ onClose: () => void }> = [];

/**
 * Lightweight accessible modal: portal to body, click-backdrop / Esc to close,
 * scroll-lock while open. On open it moves focus into the panel, traps Tab
 * within the dialog, and restores focus to the trigger on close. Renders
 * nothing when closed, so it is SSR-safe.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const entry = { onClose };
    openStack.push(entry);
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Move focus into the panel on open.
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only the topmost open dialog dismisses on Esc (supports nesting).
        if (openStack[openStack.length - 1] === entry) {
          onClose();
        }
        return;
      }
      if (e.key === "Tab") {
        const root = panelRef.current;
        if (!root) return;
        const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const idx = openStack.indexOf(entry);
      if (idx >= 0) openStack.splice(idx, 1);
      // Restore focus to whatever opened the dialog.
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-100 grid place-items-end sm:place-items-center">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "relative z-10 max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-border/60 glass card-elevated p-6 outline-none sm:max-w-lg sm:rounded-3xl",
          className,
        )}
      >
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
