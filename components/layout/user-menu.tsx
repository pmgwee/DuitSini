"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";

function initialsFrom(email?: string | null, name?: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "·";
  const parts = source.split(/[\s@._]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export interface AuthUser {
  email: string | null;
  fullName: string | null;
}

/**
 * Header account control. Shows the signed-in user's avatar/initials and email,
 * with a sign-out action that revokes the session server-side via the
 * `signOut` server action.
 */
export function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const initials = initialsFrom(user.email, user.fullName);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-border/60 bg-surface/50 py-1 pl-1 pr-2 transition-colors hover:bg-accent"
      >
        <span className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-primary to-info text-[11px] font-semibold text-primary-foreground ring-1 ring-border">
          {initials}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-60 overflow-hidden rounded-2xl border border-border/60 glass card-elevated p-1.5"
        >
          <div className="px-3 py-2">
            <div className="text-xs text-muted-foreground">Signed in as</div>
            <div className="truncate text-sm font-medium">
              {user.email ?? "Account"}
            </div>
          </div>
          <div className="my-1 h-px bg-border/60" />
          <form action={signOut}>
            <button
              type="submit"
              role="menuitem"
              className={cn(
                "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground",
              )}
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
