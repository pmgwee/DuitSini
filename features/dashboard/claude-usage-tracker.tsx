"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useClaudeUsage, type UsageState } from "@/lib/stores/claude-usage";
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
 * Claude Pro usage tracker: a rolling 5-hour session window and a 7-day weekly
 * window with live reset timers, a user-set intensity estimate, and a notes
 * log. Per the blueprint, it deliberately never claims exact remaining messages.
 */
export function ClaudeUsageTracker() {
  const now = useNow(1000);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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

  if (!mounted || now === null) {
    return (
      <WidgetShell>
        <div className="grid h-44 place-items-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      </WidgetShell>
    );
  }

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
    <WidgetShell>
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" /> Claude usage
        </div>
        <span className="text-[11px] text-muted-foreground">estimated · not exact</span>
      </header>

      {/* 5-hour session */}
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
                : "Rolling 5-hour window. Anthropic doesn't publish exact limits, so this is a time estimate only."
              : "Start a rolling 5-hour window to track your Claude session. The 7-day window starts with it."}
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

      {/* 7-day window */}
      <div className="mt-5">
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

      {/* Intensity */}
      <div className="mt-5">
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

      {/* Notes */}
      <NotesEditor notes={notes} onAdd={addNote} onRemove={removeNote} />
    </WidgetShell>
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
    <div className="mt-5">
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

function WidgetShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">{children}</div>;
}

function ProgressRing({
  progress,
  size = 128,
  stroke = 10,
  children,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  children: React.ReactNode;
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
          stroke="var(--primary)"
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
