"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading color dot (e.g. category color). */
  color?: string;
}

/**
 * Accessible styled dropdown that replaces the native `<select>` (whose menu is
 * OS-rendered and can't be themed). Fully keyboard-navigable, closes on outside
 * click / Escape, and flips upward when there isn't room below. Escape and click
 * events are stopped from bubbling so it works inside a modal Dialog without
 * closing it.
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [flipUp, setFlipUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // On open, decide flip direction and sync the active index to the selection.
  const openMenu = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      setFlipUp(spaceBelow < 280 && rect.top > spaceBelow);
    }
    const i = options.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
    setOpen(true);
  };

  // Keep the active option scrolled into view while navigating.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commit = (i: number) => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // don't let a parent Dialog close
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className="flex h-11 w-full items-center gap-2 rounded-xl border border-border/60 bg-input/50 px-3 text-left text-sm outline-none transition-[border-color,box-shadow] focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {selected?.color ? (
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: selected.color }} />
        ) : null}
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? "Select…"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className={cn(
            "absolute left-0 z-50 max-h-30 w-full overflow-y-auto rounded-xl border border-border/60 bg-surface p-1 shadow-xl shadow-black/40 outline-none",
            flipUp ? "bottom-[calc(100%+0.25rem)]" : "top-[calc(100%+0.25rem)]",
          )}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIndex;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm",
                  isActive ? "bg-accent text-foreground" : "text-foreground/90",
                )}
              >
                {opt.color ? (
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: opt.color }}
                  />
                ) : null}
                <span className="flex-1 truncate">{opt.label}</span>
                {isSelected ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
