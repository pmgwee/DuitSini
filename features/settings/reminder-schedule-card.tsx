"use client";

import { useState } from "react";
import { CalendarClock, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { primeGlobalReminderDefaults } from "@/lib/reminders/global-default";

type Flash = { kind: "ok" | "error"; text: string };

const OPTIONS = [7, 3, 1, 0] as const;
const STANDARD = [7, 3, 1];
const MINIMAL = [1];

const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && b.every((n) => a.includes(n));

/** "7 days, 3 days and 1 day" / "same day" / "1 day". */
function describeDays(offsets: number[]): string {
  if (offsets.length === 0) return "never";
  const names = [...offsets]
    .sort((x, y) => y - x)
    .map((d) => (d === 0 ? "same day" : `${d} day${d === 1 ? "" : "s"}`));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The user's DEFAULT reminder schedule (applies to every subscription that
 * hasn't customized its own offsets — NULL = inherit). Two preset chips + four
 * day checkboxes (incl. same-day). Mirrors telegram-card conventions: initialX
 * props, optimistic save, single flash slot. The "at least one" rule is enforced
 * here (last-box guard) and in the API (min(1)).
 */
export function ReminderScheduleCard({
  initialOffsets,
  customizedCount,
}: {
  initialOffsets: number[];
  customizedCount: number;
}) {
  const [offsets, setOffsets] = useState<number[]>(() =>
    [...initialOffsets].sort((a, b) => b - a),
  );
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const notify = (f: Flash) => {
    setFlash(f);
    setTimeout(() => setFlash(null), 4500);
  };

  const save = async (next: number[]) => {
    const prev = offsets;
    setOffsets([...next].sort((a, b) => b - a));
    setSaving(true);
    setFlash(null);
    try {
      const r = await fetch("/api/settings/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offsets: next }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        offsets?: number[];
        error?: string;
      };
      if (!r.ok || !d.ok) throw new Error(d.error || "Couldn't save.");
      // The server canonicalizes (dedupe/sort); sync to its result.
      if (Array.isArray(d.offsets)) setOffsets([...d.offsets].sort((a, b) => b - a));
      // Push the saved schedule into the session cache so the Add/Edit form
      // picks it up instantly on the next open (no refetch, no flash).
      primeGlobalReminderDefaults(d.offsets ?? next);
      notify({ kind: "ok", text: "Saved." });
    } catch (e) {
      setOffsets(prev);
      notify({ kind: "error", text: e instanceof Error ? e.message : "Failed to save." });
    } finally {
      setSaving(false);
    }
  };

  const toggle = (day: number) => {
    const has = offsets.includes(day);
    if (has && offsets.length === 1) return; // last-box guard (UI side)
    const next = has ? offsets.filter((d) => d !== day) : [...offsets, day];
    void save(next);
  };

  const applyPreset = (preset: number[]) => {
    if (sameSet(offsets, preset)) return;
    void save(preset);
  };

  const isStandard = sameSet(offsets, STANDARD);
  const isMinimal = sameSet(offsets, MINIMAL);

  return (
    <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="size-4 text-primary" /> Default reminder schedule
        </h2>
        {saving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Applies to all subscriptions unless you customize one individually.
      </p>

      {/* Preset chips */}
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Quick:</span>
        <button
          type="button"
          onClick={() => applyPreset(STANDARD)}
          aria-pressed={isStandard}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs transition-colors",
            isStandard
              ? "border-primary bg-primary/10 text-primary"
              : "border-border/60 text-muted-foreground hover:text-foreground",
          )}
        >
          Standard
        </button>
        <button
          type="button"
          onClick={() => applyPreset(MINIMAL)}
          aria-pressed={isMinimal}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs transition-colors",
            isMinimal
              ? "border-primary bg-primary/10 text-primary"
              : "border-border/60 text-muted-foreground hover:text-foreground",
          )}
        >
          Minimal
        </button>
      </div>

      {/* Day checkboxes */}
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-2">
        {OPTIONS.map((day) => {
          const ticked = offsets.includes(day);
          const isLast = ticked && offsets.length === 1;
          return (
            <label key={day} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={ticked}
                disabled={saving || isLast}
                onChange={() => toggle(day)}
              />
              <span className={cn(isLast && "text-muted-foreground")}>
                {day === 0 ? "Same day" : `${day} day${day === 1 ? "" : "s"}`}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground/80">
        Keep at least one — use the Reminders toggle to turn everything off.
      </p>

      {/* Summary */}
      <p className="text-sm">
        You&apos;ll be reminded <b>{describeDays(offsets)}</b> before each charge, bundled into
        one morning digest.
      </p>

      {/* Override visibility */}
      {customizedCount > 0 ? (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground">
          <CheckCircle2 className="size-3.5" />
          {customizedCount} subscription{customizedCount === 1 ? "" : "s"} use their own schedule
        </p>
      ) : null}

      {flash ? (
        <p
          className={cn(
            "mt-3 text-xs",
            flash.kind === "ok" ? "text-success" : "text-danger",
          )}
        >
          {flash.text}
        </p>
      ) : null}
    </section>
  );
}
