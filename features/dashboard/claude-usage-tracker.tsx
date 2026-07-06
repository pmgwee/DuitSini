"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useClaudeUsage, type UsageState } from "@/lib/stores/claude-usage";
import { useClaudeUsageLive, type LiveUsage, type LiveUsageWindow } from "./use-claude-usage-live";
import { useNow } from "./use-now";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const STATES: { value: UsageState; label: string; tone: string }[] = [
  { value: "light", label: "Light", tone: "text-success" },
  { value: "medium", label: "Medium", tone: "text-warning" },
  { value: "heavy", label: "Heavy", tone: "text-danger" },
];

/**
 * Claude Pro usage tracker. Defaults to a **live** view (real 5h/7d plan usage
 * synced from the local Claude Usage Bridge companion) and falls back to a
 * manual estimate when the bridge isn't running. Per the blueprint, it never
 * claims exact remaining messages — the live figures are utilization %.
 */
export function ClaudeUsageTracker() {
  const now = useNow(1000);
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<"live" | "manual">("live");
  useEffect(() => setMounted(true), []);
  const live = useClaudeUsageLive();

  if (!mounted || now === null) {
    return (
      <WidgetShell>
        <div className="grid h-44 place-items-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      </WidgetShell>
    );
  }

  const liveReady =
    mode === "live" &&
    live.status === "live" &&
    live.data &&
    (hasWindow(live.data.five_hour) || hasWindow(live.data.seven_day));

  return (
    <WidgetShell>
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" /> Claude usage
          {liveReady ? (
            <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
              Live
            </span>
          ) : null}
        </div>
        <div className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-surface/40 p-0.5 text-xs">
          <ModeTab active={mode === "live"} onClick={() => setMode("live")}>
            Live
          </ModeTab>
          <ModeTab active={mode === "manual"} onClick={() => setMode("manual")}>
            Manual
          </ModeTab>
        </div>
      </header>

      {liveReady && live.data ? (
        <LiveView data={live.data} now={now} />
      ) : (
        <ManualView now={now} liveStatus={live.status} liveError={live.error} />
      )}
    </WidgetShell>
  );
}

function hasWindow(w?: LiveUsageWindow | null): boolean {
  return Boolean(w && w.utilization !== null && w.utilization !== undefined);
}

function utilizationColor(pct: number | null | undefined): string {
  if (pct == null) return "var(--muted-foreground)";
  if (pct >= 100) return "var(--danger)";
  if (pct >= 60) return "var(--warning)";
  return "var(--primary)";
}

function formatUntil(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  let remaining = Math.max(0, new Date(iso).getTime() - now);
  const days = Math.floor(remaining / 86_400_000);
  remaining -= days * 86_400_000;
  const hours = Math.floor(remaining / 3_600_000);
  remaining -= hours * 3_600_000;
  const mins = Math.floor(remaining / 60_000);
  if (days >= 2) return `${days}d`;
  if (days === 1) return `1d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/* ------------------------------------------------------------------ */
/* Live view — real plan usage from the local Claude Usage Bridge      */
/* ------------------------------------------------------------------ */

function LiveView({ data, now }: { data: LiveUsage; now: number }) {
  const five = data.five_hour;
  const seven = data.seven_day;
  const fivePct = five?.utilization ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        {fivePct !== null ? (
          <ProgressRing progress={(fivePct ?? 0) / 100} color={utilizationColor(fivePct)}>
            <div className="text-center">
              <div className="text-lg font-semibold tabular-nums">{Math.round(fivePct)}%</div>
              <div className="text-[11px] text-muted-foreground">5-hour</div>
            </div>
          </ProgressRing>
        ) : (
          <div className="grid size-32 place-items-center rounded-full border border-dashed border-border/60 text-center text-[11px] text-muted-foreground">
            not on a
            <br />
            5h plan
          </div>
        )}
        <div className="flex-1">
          <div className="text-sm">
            Resets in <span className="font-medium">{formatUntil(five?.resets_at, now)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Rolling 5-hour session window, synced live from your local Claude Code companion.
          </p>
        </div>
      </div>

      <LiveWindow
        label="7-day weekly window"
        pct={seven?.utilization ?? null}
        resetsAt={seven?.resets_at}
        now={now}
      />

      <p className="text-[11px] text-muted-foreground/70">
        Live · {data.cached ? "cached" : "fresh"} · unofficial endpoint (may change without notice).
      </p>
    </div>
  );
}

function LiveWindow({
  label,
  pct,
  resetsAt,
  now,
}: {
  label: string;
  pct: number | null;
  resetsAt: string | null | undefined;
  now: number;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">
          {pct === null ? "—" : `${Math.round(pct)}%`} · resets in {formatUntil(resetsAt, now)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, pct ?? 0)}%`, background: utilizationColor(pct) }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Manual view — local estimate (fallback when the bridge is down)    */
/* ------------------------------------------------------------------ */

function ManualView({
  now,
  liveStatus,
  liveError,
}: {
  now: number;
  liveStatus: "connecting" | "live" | "error";
  liveError?: string;
}) {
  const {
    sessionStartedAt,
    weekStartedAt,
    usageState,
    notes,
    startSession,
    endSession,
    resetWeek,
    setUsageState,
    addNote,
    removeNote,
  } = useClaudeUsage();

  const sessionActive = sessionStartedAt !== null;
  const sessionElapsed = sessionActive ? now - (sessionStartedAt as number) : 0;
  const sessionExpired = sessionActive && sessionElapsed >= SESSION_MS;
  const sessionRemaining = sessionActive ? Math.max(0, SESSION_MS - sessionElapsed) : 0;
  const sessionProgress = sessionActive ? Math.min(1, sessionElapsed / SESSION_MS) : 0;

  const weekActive = weekStartedAt !== null;
  const weekElapsed = weekActive ? now - (weekStartedAt as number) : 0;
  const weekExpired = weekActive && weekElapsed >= WEEK_MS;
  const weekRemainingMs = weekActive ? Math.max(0, WEEK_MS - weekElapsed) : 0;
  const weekProgress = weekActive ? Math.min(1, weekElapsed / WEEK_MS) : 0;
  const weekRemainingDays = Math.ceil(weekRemainingMs / (24 * 60 * 60 * 1000));

  const handleStart = () => {
    startSession();
    if (!weekActive || weekExpired) resetWeek();
  };

  return (
    <div className="flex flex-col gap-5">
      {liveStatus === "error" ? (
        <div className="rounded-xl border border-border/50 bg-surface/30 px-3 py-2 text-xs text-muted-foreground">
          {liveError
            ? `Live companion: ${liveError}`
            : "Live companion not detected — run the local Claude Usage Bridge to see real usage. Showing a manual estimate."}
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        {sessionActive ? (
          <ProgressRing progress={sessionProgress}>
            <div className="text-center">
              <div className="text-lg font-semibold tabular-nums">
                {sessionExpired ? "Ended" : formatDuration(sessionRemaining)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {sessionExpired ? "window over" : "left in window"}
              </div>
            </div>
          </ProgressRing>
        ) : (
          <div className="grid size-32 place-items-center rounded-full border border-dashed border-border/60 text-center text-[11px] text-muted-foreground">
            no active
            <br />
            session
          </div>
        )}

        <div className="flex flex-1 flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {sessionActive
              ? sessionExpired
                ? "Your 5-hour rolling window has ended. Start a new one to keep tracking."
                : "Rolling 5-hour window — a manual time estimate (Anthropic publishes no exact limit)."
              : "Start a rolling 5-hour window. The 7-day window starts with it."}
          </p>
          <div className="flex flex-wrap gap-2">
            {sessionActive ? (
              <>
                <Button size="sm" variant="secondary" onClick={endSession}>
                  End session
                </Button>
                <Button size="sm" variant="ghost" onClick={handleStart}>
                  <RotateCcw className="size-3.5" /> Restart
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={handleStart}>
                <Play className="size-3.5" /> Start session
              </Button>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">7-day window</span>
          <span className="text-muted-foreground">
            {!weekActive
              ? "not started"
              : weekExpired
                ? "window over — reset to restart"
                : `resets in ${weekRemainingDays}d`}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              weekExpired ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${Math.round(weekProgress * 100)}%` }}
          />
        </div>
        {weekActive && (
          <button
            type="button"
            onClick={resetWeek}
            className="mt-2 inline-flex items-center gap-1 rounded-md px-1 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="size-3" /> Reset 7-day window
          </button>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Usage intensity</div>
        <div className="flex gap-2" role="radiogroup" aria-label="Usage intensity">
          {STATES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={usageState === s.value}
              onClick={() => setUsageState(s.value)}
              className={cn(
                "flex-1 rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors",
                usageState === s.value
                  ? "border-border bg-accent text-foreground"
                  : "border-border/50 text-muted-foreground hover:text-foreground",
              )}
            >
              <span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", s.tone)} />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <NotesEditor notes={notes} onAdd={addNote} onRemove={removeNote} />
    </div>
  );
}

function NotesEditor({
  notes,
  onAdd,
  onRemove,
}: {
  notes: { id: string; text: string; at: number }[];
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">Notes</div>
      <div className="flex gap-2">
        <input
          aria-label="Add usage note"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Log what caused heavy usage…"
          maxLength={140}
          className="h-9 flex-1 rounded-xl border border-border/60 bg-input/50 px-3 text-sm outline-none focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <Button size="sm" variant="secondary" onClick={submit} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {notes.length > 0 ? (
        <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {notes.map((n) => (
            <li
              key={n.id}
              className="flex items-start gap-2 rounded-lg bg-surface/40 px-2.5 py-1.5 text-xs"
            >
              <span className="flex-1 text-muted-foreground">{n.text}</span>
              <button
                type="button"
                onClick={() => onRemove(n.id)}
                aria-label="Delete note"
                className="-m-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground/70">
          No notes yet — log what caused heavy usage.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function WidgetShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">{children}</div>;
}

function ProgressRing({
  progress,
  color = "var(--primary)",
  size = 128,
  stroke = 10,
  children,
}: {
  progress: number;
  color?: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - progress);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
