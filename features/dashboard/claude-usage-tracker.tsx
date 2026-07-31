"use client";

import { useEffect, useState } from "react";
import { Play, RefreshCw, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useClaudeUsage, type UsageState } from "@/lib/stores/claude-usage";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useClaudeUsageLive,
  type LiveUsage,
  type LiveUsageWindow,
  type UsageLimit,
  type UsageProvider,
  type UsageStream,
} from "./use-claude-usage-live";
import { useNow } from "./use-now";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentProviderIcon } from "./agent-provider-icon";
import { AgentUsageMascot } from "./agent-usage-mascot";

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

  const streams = live.data ? normalizeStreams(live.data) : [];
  const liveReady =
    mode === "live" &&
    live.status === "live" &&
    live.data &&
    streams.some(
      (s) => hasWindow(s.five_hour) || hasWindow(s.seven_day) || (Array.isArray(s.limits) && s.limits.length > 0),
    );

  const header = (
    <header className="mb-4 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 text-primary" /> Agent Usage
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
  );

  // Loading gate: still hydrating/mounting, or (in live mode) the first usage
  // snapshot hasn't resolved yet. Show a skeleton body so the widget never
  // flashes the manual fallback while real live data is on its way — that flash
  // was the per-navigation flicker. (In manual mode there's nothing to wait for,
  // so the manual view renders immediately.)
  if (!mounted || now === null || (mode === "live" && live.status === "connecting")) {
    return (
      <WidgetShell>
        {header}
        <LiveViewSkeleton />
      </WidgetShell>
    );
  }

  return (
    <WidgetShell>
      {header}
      {liveReady && live.data ? (
        <LiveView
          streams={streams}
          refreshedAt={live.data.refreshed_at}
          now={now}
          onPull={live.pull}
          pulling={live.pulling}
          pullCooldownEndsAt={live.pullCooldownEndsAt}
        />
      ) : (
        <ManualView now={now} liveStatus={live.status} liveError={live.error} />
      )}
    </WidgetShell>
  );
}

/**
 * Placeholder mirroring the LiveView layout (stream label + three ring gauges +
 * footer) so the loading → live handoff doesn't shift the widget. Shown only
 * during the first snapshot fetch, while `live.status` is still "connecting".
 */
function LiveViewSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-label="Loading live usage">
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3.5 w-12 rounded-full" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <Skeleton className="size-23 rounded-full" />
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-2 w-10" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border/50 pt-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-24 rounded-md" />
      </div>
    </div>
  );
}

/**
 * Normalize a snapshot into a streams array. The live route always returns
 * `streams`, but this also tolerates an older single-source payload by wrapping
 * its top-level fields into one synthetic stream.
 */
function normalizeStreams(data: LiveUsage): UsageStream[] {
  const streams =
    Array.isArray(data.streams) && data.streams.length > 0
      ? data.streams
      : [
          {
            source: "claude",
            label: "Claude",
            five_hour: data.five_hour ?? null,
            seven_day: data.seven_day ?? null,
            limits: data.limits ?? null,
            provider: data.provider ?? null,
          },
        ];
  const order: Record<string, number> = { claude_pro: 0, claude: 0, glm: 1, codex: 2 };
  return streams
    .map((stream, index) => ({ stream, index }))
    .sort(
      (a, b) =>
        (order[a.stream.source] ?? 99) - (order[b.stream.source] ?? 99) ||
        a.index - b.index,
    )
    .map(({ stream }) => stream);
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

function LiveView({
  streams,
  refreshedAt,
  now,
  onPull,
  pulling,
  pullCooldownEndsAt,
}: {
  streams: UsageStream[];
  refreshedAt?: string;
  now: number;
  onPull: () => void;
  pulling: boolean;
  pullCooldownEndsAt: number | null;
}) {
  // Server-enforced pull cooldown mirrored as a countdown: each honored pull
  // costs one call against the member's own Anthropic rate-limit budget, so
  // the button stays disabled until the server would accept the next one.
  const cooldownS =
    pullCooldownEndsAt !== null ? Math.max(0, Math.ceil((pullCooldownEndsAt - now) / 1000)) : 0;
  return (
    <div className="flex flex-col gap-5">
      <div className={cn("flex flex-col", streams.length > 1 ? "gap-5" : "gap-0")}>
        {streams.map((s) => (
          <StreamSection key={s.source} stream={s} now={now} divided={streams.length > 1} />
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border/50 pt-3">
        <span className="text-[11px] text-muted-foreground/80">
          Last updated: {formatAgo(refreshedAt, now)}
        </span>
        <button
          type="button"
          onClick={onPull}
          disabled={pulling || cooldownS > 0}
          aria-label="Pull latest usage from the bridge"
          title={
            cooldownS > 0
              ? "Just refreshed — manual pulls are limited to protect your account quota endpoints. Usage still updates automatically."
              : undefined
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", pulling && "animate-spin")} />
          {pulling ? "Pulling…" : cooldownS > 0 ? `Pull latest (${cooldownS}s)` : "Pull latest"}
        </button>
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground/60">
        Live · updates automatically · account quota data via local sign-ins (endpoints may change).
      </p>
    </div>
  );
}

/** One usage stream rendered as a labeled group of ring gauges. */
function StreamSection({ stream, now, divided }: { stream: UsageStream; now: number; divided: boolean }) {
  const gauges = streamGauges(stream);
  const showMascot =
    gauges.length < 3 && gauges.some((limit) => limit.group === "weekly" && limit.key === "weekly_all");
  return (
    <div className={cn(divided && "border-t border-border/40 pt-4 first:border-t-0 first:pt-0")}>
      <div className="mb-2.5 flex items-center gap-1.5">
        <AgentProviderIcon source={stream.source} />
        <span className="text-xs font-medium text-foreground">{stream.label}</span>
        <ProviderBadge provider={stream.provider} />
        {stream.cached ? (
          <span
            title={`Recent successful ${stream.label} reading reused briefly to protect its official quota endpoint. It refreshes automatically.`}
            aria-label={`${stream.label} cached reading. Recent successful data is being reused briefly and refreshes automatically.`}
            className="cursor-help rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
          >
            Cached
          </span>
        ) : null}
      </div>
      {gauges.length === 0 ? (
        <p className="py-2 text-[11px] text-muted-foreground/70">No usage limits reported for this source.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {gauges.map((l) => (
            <UsageGauge key={l.key} limit={l} now={now} />
          ))}
          {showMascot ? (
            <div className="col-start-3 row-start-1 flex justify-center pt-3">
              <AgentUsageMascot source={stream.source} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Turn a stream's windows/limits into the gauge rows (session + weekly). */
function streamGauges(stream: UsageStream): UsageLimit[] {
  const limits = Array.isArray(stream.limits) ? stream.limits : [];

  // Prefer the structured `limits` array; fall back to the raw windows so the
  // widget still works before the bridge/migration carry the richer data.
  const session: UsageLimit | null =
    limits.find((l) => l.group === "session") ??
    (stream.five_hour ? windowToLimit("session", "Current session", "session", stream.five_hour) : null);

  const weeklyFromLimits = limits.filter((l) => l.group === "weekly");
  const weekly: UsageLimit[] =
    weeklyFromLimits.length > 0
      ? weeklyFromLimits
      : stream.seven_day
        ? [windowToLimit("weekly_all", "All models", "weekly", stream.seven_day)]
        : [];

  return [session, ...weekly].filter((l): l is UsageLimit => l !== null);
}

/** Adapt a raw usage window into a UsageLimit row for the fallback path. */
function windowToLimit(
  key: string,
  label: string,
  group: "session" | "weekly",
  w: LiveUsageWindow,
): UsageLimit {
  return { key, label, group, percent: w.utilization, resets_at: w.resets_at, severity: null };
}

function formatAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < 45_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One compact ring gauge — used for each limit (session + weekly models). */
function UsageGauge({
  limit,
  now,
}: {
  limit: UsageLimit;
  now: number;
}) {
  const pct = limit.percent;
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <ProgressRing
        progress={(pct ?? 0) / 100}
        color={utilizationColor(pct)}
        size={92}
        stroke={8}
      >
        <div className="text-sm font-semibold tabular-nums">
          {pct == null ? "—" : `${Math.round(pct)}%`}
        </div>
      </ProgressRing>
      <div className="text-[11px] font-medium leading-tight">{limit.label}</div>
      <div className="text-[10px] text-muted-foreground">
        resets {formatUntil(limit.resets_at, now)}
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

/**
 * Shown only when the bridge machine has cc-switch routed to a non-Anthropic
 * gateway (e.g. GLM/z.ai) for Claude Code's coding requests. Purely
 * informational — the usage % above always reflects the real Claude account,
 * regardless of which gateway is currently handling prompts.
 */
function ProviderBadge({ provider }: { provider?: UsageProvider | null }) {
  if (!provider || provider.official) return null;
  return (
    <span
      title={`Claude Code is currently routed through ${provider.gateway_host ?? "a gateway"} for coding requests. This usage % still reflects your real Claude account.`}
      className="rounded-full bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info"
    >
      via {provider.name ?? provider.gateway_host ?? "gateway"}
    </span>
  );
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
