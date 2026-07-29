"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
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
 * The <body> inline overflow captured BEFORE the first dialog opened, restored
 * when the last one closes. Global (stack-counted) rather than per-dialog on
 * purpose: see the lock logic in the effect.
 */
let savedBodyOverflow = "";

/**
 * Lightweight accessible modal: portal to body, click-backdrop / Esc to close,
 * scroll-lock while open. On open it moves focus into the panel, traps Tab
 * within the dialog, and restores focus to the trigger on close. Renders its
 * content through AnimatePresence so backdrop + panel enter AND exit animate
 * (no hard cut on dismiss). SSR-safe (renders nothing without a document).
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

  // Keep the latest `onClose` in a ref. Callers pass an inline
  // `() => setOpen(false)` whose identity changes every render; if `onClose`
  // were in the effect deps below, the open effect would tear down + re-run on
  // every parent render, churning the body scroll-lock snapshot/restore. That
  // churn — combined with nested dialogs — could leave <body> stuck on
  // overflow:hidden after the dialog closed (e.g. clicking the "default
  // schedule" link inside the form navigated away but the destination page
  // stayed frozen until a hard refresh). Reading via the ref avoids the churn.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const entry = { onClose: () => onCloseRef.current() };
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Ref-counted scroll lock: capture the body's original overflow only when
    // the FIRST dialog opens, and restore it only when the LAST one closes. A
    // per-dialog snapshot (the old approach) is unsafe under nesting + arbitrary
    // cleanup order — the inner dialog snapshotted the "hidden" the outer dialog
    // set, and if it cleaned up last it wrote "hidden" back, locking the page.
    if (openStack.length === 0) savedBodyOverflow = document.body.style.overflow;
    openStack.push(entry);
    document.body.style.overflow = "hidden";
    // Move focus into the panel on open.
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only the topmost open dialog dismisses on Esc (supports nesting).
        if (openStack[openStack.length - 1] === entry) {
          onCloseRef.current();
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
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = openStack.indexOf(entry);
      if (idx >= 0) openStack.splice(idx, 1);
      // Only the dialog that empties the stack restores the body — order no
      // longer matters, and the restored value is always the true original.
      if (openStack.length === 0) {
        document.body.style.overflow = savedBodyOverflow;
      }
      // Restore focus to whatever opened the dialog (only if it's still in the
      // document — after a route change the trigger may be gone).
      const trigger = previouslyFocused.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  // Close on any client-side route change. The Add/Edit dialogs live in the
  // persistent app shell, so a <Link> or sidebar nav away from the page does NOT
  // unmount them — without this, the open dialog keeps <body> scroll-locked and
  // the destination page is frozen until a hard refresh. Closing runs the normal
  // cleanup above (restores overflow + focus).
  const pathname = usePathname();
  const prevPathname = useRef(pathname);
  useEffect(() => {
    if (prevPathname.current === pathname) return;
    prevPathname.current = pathname;
    onCloseRef.current();
  }, [pathname]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          key="dialog-root"
          className="fixed inset-0 z-100 grid place-items-end sm:place-items-center"
        >
          <motion.button
            type="button"
            aria-label="Close dialog"
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={cn(
              "relative z-10 max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-border/60 glass card-elevated p-6 outline-none sm:max-w-lg sm:rounded-3xl",
              className,
            )}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.8 }}
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
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
