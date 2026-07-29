"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading color dot (e.g. category color). */
  color?: string;
  /** Extra aliases the in-dropdown search should match (e.g. "m2u" → Maybank). */
  keywords?: string[];
}

/**
 * How many option rows stay visible inside the dropdown panel at once. The list
 * max-height is derived from this so every Select shows the same number of rows
 * before scrolling (see ROW_HEIGHT / LIST_PAD).
 */
const VISIBLE_ROWS = 4;
/** Rendered row height: `py-2` (16px) + `text-sm` line (~20px) ≈ 36px. */
const ROW_HEIGHT = 36;
/** `<ul>` vertical padding (`p-1` = 4px top + 4px bottom). */
const LIST_PAD = 8;
/** Search input row height (icon input + `py-1.5` border row). */
const SEARCH_ROW = 41;

/**
 * Accessible styled dropdown that replaces the native `<select>` (whose menu is
 * OS-rendered and can't be themed). Fully keyboard-navigable, closes on outside
 * click / Escape, and flips upward when there isn't room below. Escape and click
 * events are stopped from bubbling so it works inside a modal Dialog without
 * closing it.
 *
 * The panel always shows {@link VISIBLE_ROWS} rows before scrolling. When there
 * are more than VISIBLE_ROWS options it also mounts a sticky search input at the
 * top of the panel (filter by label + each option's `keywords`). Pass
 * `searchable={false}` to suppress the search box on a specific field — e.g. the
 * outer "Payment method" picker, which is a short personal list that should read
 * at a glance.
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  id,
  searchable = true,
  searchPlaceholder = "Search…",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  className?: string;
  id?: string;
  /** Show the search box (only has an effect when there are > VISIBLE_ROWS options). */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [flipUp, setFlipUp] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  // Search appears only when the list is long enough to need it (and not opted out).
  const showSearch = searchable && options.length > VISIBLE_ROWS;

  const filtered = useMemo(() => {
    if (!showSearch) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      if (o.label.toLowerCase().includes(q)) return true;
      return (o.keywords ?? []).some((k) => k.toLowerCase().includes(q));
    });
  }, [options, query, showSearch]);

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

  // Focus the search input when the menu opens (keyboard users can type right
  // away); return focus to the trigger when it closes so Tab flows onward.
  useEffect(() => {
    if (!open) return;
    if (showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  // Keep the active option scrolled into view while navigating.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  // Clamp the active index whenever the filtered set shrinks (typing a query).
  useEffect(() => {
    if (!open) return;
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  // Close when keyboard focus leaves the component entirely (e.g. Tab to the next
  // field). Focus moving between the trigger, the search input, and the clear
  // button all stays inside `rootRef`, so only a true departure closes the panel.
  const onBlurRoot: React.FocusEventHandler<HTMLDivElement> = (e) => {
    const next = e.relatedTarget as Node | null;
    if (rootRef.current && next && rootRef.current.contains(next)) return;
    setOpen(false);
  };

  // On open, decide flip direction from the real panel height, reset any query,
  // and sync the active index to the current selection.
  const openMenu = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const panelH =
        (showSearch ? SEARCH_ROW : 0) + VISIBLE_ROWS * ROW_HEIGHT + LIST_PAD + 16;
      const spaceBelow = window.innerHeight - rect.bottom;
      setFlipUp(spaceBelow < panelH && rect.top > spaceBelow);
    }
    setQuery("");
    const i = options.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
    setOpen(true);
  };

  const commit = (i: number) => {
    const opt = filtered[i];
    if (!opt) return; // e.g. Enter on an empty result set — leave the menu open.
    onChange(opt.value);
    close();
  };

  const move = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
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
        setActiveIndex(filtered.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
    }
  };

  // Trigger keyboard handling. When there's no search box, the trigger drives
  // arrow/enter navigation directly (DOM focus stays on it). With a search box,
  // focus lives in the input and the trigger only handles open/close.
  const onKeyDownTrigger = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // don't let a parent Dialog close
        close();
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
    if (!showSearch) move(e);
  };

  const onKeyDownSearch = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
      move(e);
    }
  };

  // id of the currently-highlighted option, exposed via aria-activedescendant so
  // screen readers announce the active row during arrow navigation (DOM focus
  // stays on the trigger/search input — it never enters the listbox itself).
  const activeOptionId =
    filtered.length > 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} onBlur={onBlurRoot} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? activeOptionId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDownTrigger}
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
        <div
          className={cn(
            "absolute left-0 z-50 flex w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-surface shadow-xl shadow-black/40 outline-none",
            flipUp ? "bottom-[calc(100%+0.25rem)]" : "top-[calc(100%+0.25rem)]",
          )}
        >
          {showSearch && (
            <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onKeyDownSearch}
                placeholder={searchPlaceholder}
                role="combobox"
                aria-controls={listboxId}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-activedescendant={activeOptionId}
                aria-label={`Search ${ariaLabel ?? "options"}`}
                autoComplete="off"
                className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              />
              {query ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Clear search"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          )}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            className={cn(
              // max-height = VISIBLE_ROWS × row height + list padding, so exactly
              // four rows show before the scrollbar engages. Drop both when the
              // list is empty so the <ul> collapses (no gap above "No matches").
              "w-full overflow-y-auto",
              filtered.length > 0 && "p-1",
            )}
            style={{
              maxHeight:
                filtered.length > 0 ? VISIBLE_ROWS * ROW_HEIGHT + LIST_PAD : undefined,
            }}
          >
            {filtered.map((opt, i) => {
              const isSelected = opt.value === value;
              const isActive = i === activeIndex;
              return (
                <li
                  key={opt.value}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => e.preventDefault()}
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
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
