"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Flash = { kind: "ok" | "error"; text: string };

/**
 * Telegram connect + test + enable/disable card. The server passes the current
 * connect/enable state (from `user_profiles`); this component optimistically
 * updates and reconciles via the integration routes. "Connected" flips true once
 * a test message succeeds (the most reliable signal the webhook linked the chat).
 */
export function TelegramCard({
  initialConnected,
  initialEnabled,
}: {
  initialConnected: boolean;
  initialEnabled: boolean;
}) {
  const [connected, setConnected] = useState(initialConnected);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const notify = (f: Flash) => {
    setFlash(f);
    setTimeout(() => setFlash(null), 4500);
  };

  const connect = async () => {
    setConnecting(true);
    setFlash(null);
    try {
      const r = await fetch("/api/integrations/telegram/connect", {
        headers: { Accept: "application/json" },
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
      if (!r.ok || !d.url) throw new Error(d.error || "Couldn't create the link.");
      window.open(d.url, "_blank", "noopener,noreferrer");
      notify({ kind: "ok", text: "Telegram opened — tap Start there, then come back and test." });
    } catch (e) {
      notify({ kind: "error", text: e instanceof Error ? e.message : "Failed to start." });
    } finally {
      setConnecting(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setFlash(null);
    try {
      const r = await fetch("/api/integrations/telegram/test", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && d.ok) {
        setConnected(true);
        notify({ kind: "ok", text: "Test message sent — check Telegram." });
      } else {
        throw new Error(d.error || "Test failed.");
      }
    } catch (e) {
      notify({ kind: "error", text: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  const toggle = async (next: boolean) => {
    setToggling(true);
    setFlash(null);
    try {
      const r = await fetch("/api/integrations/telegram/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || "Couldn't update.");
      setEnabled(next);
    } catch (e) {
      notify({ kind: "error", text: e instanceof Error ? e.message : "Failed to update." });
    } finally {
      setToggling(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Send className="size-4 text-primary" /> Telegram reminders
        </h2>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
            connected
              ? "bg-success/15 text-success"
              : "bg-muted/60 text-muted-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground/60")} />
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Get a Telegram message before each subscription renews or a free trial converts.
        {!connected ? " Connect once, then keep it enabled." : " Test it any time, or turn it off below."}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {!connected ? (
          <Button onClick={connect} disabled={connecting}>
            {connecting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
            {connecting ? "Preparing…" : "Connect Telegram"}
          </Button>
        ) : (
          <Button variant="secondary" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {testing ? "Sending…" : "Send test message"}
          </Button>
        )}

        {connected && (
          <Button
            variant={enabled ? "outline" : "default"}
            onClick={() => toggle(!enabled)}
            disabled={toggling}
          >
            {toggling ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            {enabled ? "Reminders on" : "Enable reminders"}
          </Button>
        )}
      </div>

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

      <details className="mt-4 rounded-lg border border-border/40 bg-surface/30 px-3 py-2 text-[11px] text-muted-foreground/80">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">
          Setting up a bot (admin, once)
        </summary>
        <p className="mt-1.5">
          Create a bot with <b className="text-foreground">@BotFather</b>, then set these env vars:
          <code className="ml-1 font-mono text-[10px]">TELEGRAM_BOT_TOKEN</code>,
          <code className="ml-1 font-mono text-[10px]">TELEGRAM_BOT_USERNAME</code>,
          <code className="ml-1 font-mono text-[10px]">TELEGRAM_WEBHOOK_SECRET</code>,
          <code className="ml-1 font-mono text-[10px]">CRON_SECRET</code>.
        </p>
        <p className="mt-1.5">Then register the webhook once:</p>
        <pre className="mt-1 overflow-x-auto rounded bg-background/70 px-2 py-1.5 font-mono text-[10px] text-foreground">{`curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<SITE>/api/integrations/telegram/webhook&secret_token=<WEBHOOK_SECRET>"`}</pre>
      </details>
    </section>
  );
}
