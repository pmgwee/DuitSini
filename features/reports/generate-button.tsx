"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Flash = { kind: "ok" | "error"; text: string };

/**
 * Client island on the reports index: regenerate (or create) the caller's own
 * statement for a closed period via R6 (POST /api/reports/generate), then refresh
 * the server list so the new row appears. Mirrors the settings cards' optimistic
 * flash pattern.
 */
export function GenerateButton({
  periodKey,
  label = "Generate last month",
  variant = "default",
}: {
  periodKey: string;
  label?: string;
  variant?: "default" | "secondary" | "outline";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const run = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodKey }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || "Couldn't generate.");
      setFlash({ kind: "ok", text: "Report ready." });
      router.refresh();
    } catch (e) {
      setFlash({ kind: "error", text: e instanceof Error ? e.message : "Failed to generate." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant={variant} onClick={run} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        {busy ? "Generating…" : label}
      </Button>
      {flash ? (
        <p className={cn("text-xs", flash.kind === "ok" ? "text-success" : "text-danger")}>
          {flash.text}
        </p>
      ) : null}
    </div>
  );
}
