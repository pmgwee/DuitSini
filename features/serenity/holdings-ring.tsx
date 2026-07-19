"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { HoldingView } from "@/lib/serenity/types";
import { formatPct, RatingChip, returnFill, SOURCE_BASE } from "./shared";

// Ring geometry (viewBox 0 0 300 300, drawn from 12 o'clock clockwise).
const CX = 150;
const CY = 150;
const R_OUT = 118;
const R_IN = 80;
const GAP_DEG = 1.2;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Annular-sector path from startDeg to endDeg (degrees, clockwise from top). */
function sector(rIn: number, rOut: number, start: number, end: number): string {
  const [x1, y1] = polar(CX, CY, rOut, start);
  const [x2, y2] = polar(CX, CY, rOut, end);
  const [x3, y3] = polar(CX, CY, rIn, end);
  const [x4, y4] = polar(CX, CY, rIn, start);
  const large = end - start > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${rOut} ${rOut} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rIn} ${rIn} 0 ${large} 0 ${x4} ${y4} Z`;
}

function StatTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="glass card-elevated flex min-w-0 flex-col gap-1 rounded-2xl border border-border/60 p-4">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
      {sub ? <span className="truncate text-[11px] text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

export function HoldingsRing({ holdings }: { holdings: HoldingView[] }) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);

  const stats = useMemo(() => {
    const total = holdings.reduce((s, h) => s + h.weightConviction, 0) || 1;
    const convReturn = holdings.reduce((s, h) => s + h.weightConviction * h.returnPct, 0) / total;
    const eqReturn = holdings.length ? holdings.reduce((s, h) => s + h.returnPct, 0) / holdings.length : 0;
    const wins = holdings.filter((h) => h.returnPct > 0).length;
    return {
      total,
      convReturn,
      eqReturn,
      winRate: holdings.length ? wins / holdings.length : 0,
      count: holdings.length,
    };
  }, [holdings]);

  const arcs = useMemo(() => {
    let cursor = 0;
    return holdings.map((h, i) => {
      const sweep = (h.weightConviction / stats.total) * 360;
      const start = cursor + GAP_DEG / 2;
      const end = cursor + sweep - GAP_DEG / 2;
      cursor += sweep;
      return { h, i, start, end, d: sector(R_IN, R_OUT, start, end), fill: returnFill(h.returnPct) };
    });
  }, [holdings, stats.total]);

  const center = active != null ? holdings[active] : null;
  const centerReturn = center ? center.returnPct : stats.convReturn;

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label="Reconstructed holdings and contribution"
      className="glass card-elevated rounded-3xl border border-border/60 p-5 sm:p-6"
    >
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">Holdings &amp; performance</h2>
        <p className="text-xs text-muted-foreground">
          His reconstructed book. Arc = position size · color = return. Hover an arc or row.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="🔥 Top picks"
          value={formatPct(stats.convReturn)}
          sub="his strongest buys, weighted"
          accent={stats.convReturn >= 0 ? "var(--success)" : "var(--danger)"}
        />
        <StatTile
          label="All names"
          value={formatPct(stats.eqReturn)}
          sub="every pick, equal size"
          accent={stats.eqReturn >= 0 ? "var(--success)" : "var(--danger)"}
        />
        <StatTile label="Win rate" value={`${Math.round(stats.winRate * 100)}%`} sub={`${stats.count} names tracked`} />
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* Ring */}
        <div className="relative mx-auto w-full max-w-[340px]">
          <svg viewBox="0 0 300 300" className="w-full" role="img" aria-label="Holdings weighted ring">
            <circle
              cx={CX}
              cy={CY}
              r={(R_OUT + R_IN) / 2}
              fill="none"
              stroke="color-mix(in oklch, var(--foreground) 8%, transparent)"
              strokeWidth={R_OUT - R_IN}
            />
            {arcs.map((a) => {
              const dimmed = active != null && active !== a.i;
              return (
                <path
                  key={a.h.ticker}
                  d={a.d}
                  fill={a.fill}
                  opacity={active == null ? 0.92 : dimmed ? 0.22 : 1}
                  style={{ transition: "opacity 160ms ease" }}
                  onMouseEnter={() => setActive(a.i)}
                  onMouseLeave={() => setActive(null)}
                  className="cursor-pointer outline-none"
                  tabIndex={0}
                  onFocus={() => setActive(a.i)}
                  onBlur={() => setActive(null)}
                >
                  <title>{`${a.h.ticker} — ${formatPct(a.h.returnPct)} · ${a.h.rating}`}</title>
                </path>
              );
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div className="max-w-[180px]">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {center ? center.ticker : "top-picks return"}
              </div>
              <div
                className="text-3xl font-semibold tracking-tight tabular-nums"
                style={{ color: centerReturn >= 0 ? "var(--success)" : "var(--danger)" }}
              >
                {formatPct(centerReturn)}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {center ? center.company || "—" : "conviction-weighted"}
              </div>
            </div>
          </div>
        </div>

        {/* Holdings list — grid rows so every column lines up across rows. */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[10px_52px_minmax(0,1fr)_58px] items-center gap-2.5 px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 md:grid-cols-[10px_56px_minmax(0,1fr)_64px_minmax(0,96px)] md:gap-3">
            <span />
            <span>Ticker</span>
            <span className="hidden sm:block">Name</span>
            <span className="text-right">Return</span>
            <span className="hidden text-right md:block">Rating</span>
          </div>
          <ul className="flex max-h-[380px] flex-col gap-0.5 overflow-y-auto pr-1">
            {holdings.map((h, i) => {
              const dimmed = active != null && active !== i;
              return (
                <li key={h.ticker}>
                  <a
                    href={`${SOURCE_BASE}/universe/${h.ticker.toLowerCase()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className={cn(
                      "grid grid-cols-[10px_52px_minmax(0,1fr)_58px] items-center gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 md:grid-cols-[10px_56px_minmax(0,1fr)_64px_minmax(0,96px)] md:gap-3",
                      dimmed && "opacity-40",
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ background: returnFill(h.returnPct) }} aria-hidden />
                    <span className="text-sm font-semibold tracking-tight">{h.ticker}</span>
                    <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{h.company || "—"}</span>
                    <span
                      className="text-right text-sm font-medium tabular-nums"
                      style={{ color: h.returnPct >= 0 ? "var(--success)" : "var(--danger)" }}
                    >
                      {formatPct(h.returnPct)}
                    </span>
                    <span className="hidden justify-end md:flex">
                      <RatingChip rating={h.rating} />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </motion.section>
  );
}
