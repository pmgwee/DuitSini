"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Member-facing "share your Claude usage" card. Non-technical by design: one
 * download button + plain-language steps. The ZIP it downloads contains a
 * self-contained bridge (their per-user token baked in) + double-click launchers.
 */
export function ConnectClaudeCard() {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const r = await fetch("/api/claude-usage/live", { headers: { Accept: "application/json" } });
        const d = await r.json().catch(() => ({ error: "x" }));
        if (active) setConnected(r.ok && !d.error);
      } catch {
        if (active) setConnected(false);
      }
    };
    check();
    const id = setInterval(check, 10_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Share2 className="size-4 text-primary" /> Share your Claude usage
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="size-3" /> Connected
          </span>
        ) : null}
      </div>

      {connected ? (
        <p className="text-sm text-muted-foreground">
          Your usage is broadcasting to this dashboard — nice! Keep the little window on your
          computer open. To stop, just close it. Need the file again?{" "}
          <a
            href="/api/bridge/download"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Download again
          </a>
          .
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            See your own Claude usage here, live — no coding needed. Download the little helper, run
            it once, and keep it open.
          </p>

          <Button asChild size="lg">
            <a href="/api/bridge/download">
              <Download className="size-4" /> Download my usage sharer
            </a>
          </Button>

          <ol className="mt-4 space-y-2.5 text-sm text-muted-foreground">
            <Step n={1}>Click the button above and save the ZIP file.</Step>
            <Step n={2}>
              Open it and unzip (right-click → <b className="text-foreground">Extract All</b>). A
              README inside explains everything.
            </Step>
            <Step n={3}>
              Double-click <b className="text-foreground">START-HERE (Windows)</b> — or{" "}
              <b className="text-foreground">start (Mac)</b>. Keep the window that opens open.
            </Step>
            <Step n={4}>Done! Your usage appears above, live. Close the window anytime to stop.</Step>
          </ol>

          <p className="mt-3 text-[11px] text-muted-foreground/70">
            Only your usage percentages are sent — never your password or login. You need Claude Code
            signed in with your own Claude Pro/Max account.
          </p>
        </>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}
