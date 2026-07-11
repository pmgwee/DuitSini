"use client";

import { useState } from "react";
import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Flash = { kind: "ok" | "error"; text: string };

/**
 * Monthly + yearly report generation toggles. Mirrors the sibling settings cards:
 * optimistic update + single flash slot, POSTing only the changed flag (the API
 * leaves the other untouched). Reports always appear in-app once generated; these
 * flags gate the 1st-of-month cron generation (and the Telegram highlight send).
 */
export function ReportsCard({
  initialMonthly,
  initialYearly,
}: {
  initialMonthly: boolean;
  initialYearly: boolean;
}) {
  const [monthly, setMonthly] = useState(initialMonthly);
  const [yearly, setYearly] = useState(initialYearly);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const notify = (f: Flash) => {
    setFlash(f);
    setTimeout(() => setFlash(null), 4500);
  };

  const save = async (key: "monthly" | "yearly", next: boolean) => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch("/api/settings/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || "Couldn't save.");
      if (key === "monthly") setMonthly(next);
      else setYearly(next);
      notify({ kind: "ok", text: "Saved." });
    } catch (e) {
      notify({ kind: "error", text: e instanceof Error ? e.message : "Failed to save." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
      <div className="mb-4 flex items-center gap-2">
        <FileText className="size-4 text-primary" />
        <h2 className="text-sm font-medium">Reports</h2>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Reports generate on the 1st and are sent via Telegram if connected — they always appear
        in{" "}
        <Link href="/reports" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
          Reports <ArrowRight className="size-3" />
        </Link>{" "}
        either way.
      </p>

      <div className="flex flex-col divide-y divide-border/50">
        <ToggleRow
          label="Monthly report"
          description="A statement on the 1st for the month just ended."
          checked={monthly}
          disabled={busy}
          onChange={(v) => save("monthly", v)}
        />
        <ToggleRow
          label="Yearly report"
          description="A full-year statement every January 1st."
          checked={yearly}
          disabled={busy}
          onChange={(v) => save("yearly", v)}
        />
      </div>

      {flash ? (
        <p className={cn("mt-3 text-xs", flash.kind === "ok" ? "text-success" : "text-danger")}>
          {flash.text}
        </p>
      ) : null}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "inline-block size-5 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
