"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Flash = { kind: "ok" | "error"; text: string };

/**
 * "Send to Telegram" — renders the stored report to PDF server-side (Chromium)
 * and posts the file to the user's linked chat. Shown disabled with a Settings
 * link when Telegram isn't connected. The render can take ~10–30s on a cold
 * first call (Chromium pack fetch), so the button shows a "Rendering…" state.
 */
export function SendTelegramButton({
  periodKey,
  linked,
}: {
  periodKey: string;
  linked: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const notify = (f: Flash) => {
    setFlash(f);
    setTimeout(() => setFlash(null), 6000);
  };

  const send = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch(`/api/reports/${periodKey}/send-telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || "Send failed.");
      notify({ kind: "ok", text: "Sent to Telegram — check your chat." });
    } catch (e) {
      notify({ kind: "error", text: e instanceof Error ? e.message : "Send failed." });
    } finally {
      setBusy(false);
    }
  };

  if (!linked) {
    return (
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="sm" disabled>
          <Send className="size-4" /> Send to Telegram
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Link Telegram in{" "}
          <Link href="/settings" className="underline hover:text-foreground">
            Settings
          </Link>{" "}
          first.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" onClick={send} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {busy ? "Rendering…" : "Send to Telegram"}
      </Button>
      {flash ? (
        <p className={cn("text-[11px]", flash.kind === "ok" ? "text-success" : "text-danger")}>
          {flash.text}
        </p>
      ) : null}
    </div>
  );
}
