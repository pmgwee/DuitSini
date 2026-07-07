"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Sparkles, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";

interface CookieStatus {
  connected: boolean;
  lastOkAt: string | null;
}

async function getStatus(): Promise<CookieStatus> {
  const r = await fetch("/api/yt/cookies");
  if (!r.ok) return { connected: false, lastOkAt: null };
  return (await r.json()) as CookieStatus;
}

/**
 * Opt-in "Connect YouTube Music (advanced)" control. Google removed YT Music
 * OAuth (Nov 2024), so the only way to read the real algorithmic "Listen again"
 * shelf is to replay an authenticated browser session — the user's cookies.
 *
 * This is a power-user feature: most users never touch it and get the local
 * recency shelf. The panel is collapsed by default to keep the widget clean.
 */
export function CookieConnect() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["yt", "cookies"],
    queryFn: getStatus,
    staleTime: 60_000,
  });
  const connected = status.data?.connected ?? false;
  const lastOkAt = status.data?.lastOkAt ?? null;
  // Cookies typically last weeks-to-months; hint a re-capture past ~14 days
  // since the last successful fetch.
  const staleDays =
    lastOkAt && Math.floor((Date.now() - new Date(lastOkAt).getTime()) / 86_400_000);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["yt", "cookies"] });
    await qc.invalidateQueries({ queryKey: ["yt", "listen-again"] });
  }

  async function save() {
    const c = cookie.trim();
    if (c.length < 20) {
      setError("Paste the full Cookie header — what you have looks too short.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/yt/cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: c }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error ?? "Failed to connect.");
        return;
      }
      setCookie("");
      setOpen(false);
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    await fetch("/api/yt/cookies", { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="rounded-xl border border-border/60 bg-surface-2/30 text-xs">
      {/* Summary row — always visible; toggles the form */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="flex-1">
          <span className="font-medium text-foreground">YouTube Music recommendations</span>
          {connected ? (
            <span className="ml-1.5 text-muted-foreground">
              on{typeof staleDays === "number" && staleDays > 14 ? " · may need re-capture" : ""}
            </span>
          ) : (
            <span className="ml-1.5 text-muted-foreground">off — opt in for the real shelf</span>
          )}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 py-3">
          {connected ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Connected. YouTube Music's recommendations now appear at the top of your "Listen
                again" shelf (above your local plays), and the whole shelf reshuffles on every
                refresh.
                {typeof staleDays === "number" && staleDays > 14 && (
                  <span className="mt-1 block text-warning">
                    Last successful sync {staleDays} days ago — if recommendations look thin,
                    re-capture your cookies.
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={disconnect}
                className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Unplug className="size-3.5" /> Disconnect
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Sign in at <span className="font-medium text-foreground">music.youtube.com</span>, open
                DevTools (F12) → Network, click any <code className="font-mono">browse?key=</code>{" "}
                request, and copy the full <code className="font-mono">Cookie</code> header value below.
              </p>
              <textarea
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder="SAPISID=…; __Secure-3PAPISID=…; VISITOR_INFO1_LIVE=…"
                rows={3}
                className="w-full resize-none rounded-lg border border-border/60 bg-input/50 p-2 font-mono text-[11px] outline-none focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                These cookies grant full access to your YouTube account — stored server-side only and
                never sent to the browser. Uses an unofficial API; YouTube can revoke them anytime.
              </p>
              {error && <p className="text-[11px] text-warning">{error}</p>}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-transform hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {saving ? "Verifying…" : "Connect"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
