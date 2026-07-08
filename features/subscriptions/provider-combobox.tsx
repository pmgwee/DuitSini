"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  findProviderPreset,
  searchProviderPresets,
  type ProviderPreset,
} from "@/lib/providers";
import { ProviderMark } from "./provider-mark";

/**
 * Name field with a preset picker. Users type freely (the value is always their
 * text), and matching well-known providers surface in a dropdown. Choosing one
 * fills the name AND reports the preset so the form can auto-set category +
 * brand color — the Wallos/SubAlert "pick a known service" convenience, without
 * locking anyone out of custom entries.
 */
export function ProviderCombobox({
  value,
  onChange,
  onPresetSelect,
  id,
  placeholder = "e.g. Netflix, ChatGPT, Spotify…",
}: {
  value: string;
  onChange: (value: string) => void;
  onPresetSelect: (preset: ProviderPreset) => void;
  id?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const matches = searchProviderPresets(value, 8);
  // Show a check on the row when the typed value is exactly a known provider.
  const exact = findProviderPreset(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const choose = (preset: ProviderPreset) => {
    onChange(preset.name);
    onPresetSelect(preset);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // keep the parent Dialog open
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActiveIndex((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter" && open && matches[activeIndex]) {
      // Only intercept Enter when the highlighted row isn't already the value —
      // otherwise let the keystroke fall through (form submit stays natural).
      if (matches[activeIndex].name !== value) {
        e.preventDefault();
        choose(matches[activeIndex]);
      } else {
        setOpen(false);
      }
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          id={id}
          value={value}
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-11 w-full rounded-xl border border-border/60 bg-input/50 px-3 pr-9 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle provider suggestions"
          onClick={() => setOpen((o) => !o)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && matches.length > 0 && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 top-[calc(100%+0.25rem)] z-50 max-h-64 w-full overflow-y-auto rounded-xl border border-border/60 bg-surface p-1 shadow-xl shadow-black/40"
        >
          {matches.map((preset, i) => {
            const isActive = i === activeIndex;
            const isChosen = exact?.name === preset.name;
            return (
              <li
                key={preset.name}
                role="option"
                aria-selected={isChosen}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  // mousedown (not click) so it fires before the input blur.
                  e.preventDefault();
                  choose(preset);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm",
                  isActive ? "bg-accent text-foreground" : "text-foreground/90",
                )}
              >
                <ProviderMark
                  name={preset.name}
                  color={preset.color}
                  slug={preset.icon}
                  domain={preset.domain}
                  size="sm"
                />
                <span className="flex-1 truncate">{preset.name}</span>
                {isChosen ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
