"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  Cloud,
  Coins,
  MemoryStick,
  Package,
  Plane,
  Rocket,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NameView, SerenityTheme, ThemeGroup } from "@/lib/serenity/types";
import { RATING_STYLE, RATING_TIERS, SOURCE_BASE, StanceDot, STANCE_LEGEND, THEME_ACCENT_VAR } from "./shared";

/** A representative icon per theme, in place of a plain colored bubble. */
const THEME_ICON: Record<SerenityTheme, LucideIcon> = {
  "Optics / Silicon Photonics": Waves,
  "Memory, Storage & Servers": MemoryStick,
  "Advanced Packaging & Semicap": Package,
  "Energy, Nuclear & Battery": Zap,
  "Data Center & Cloud": Cloud,
  "Drones & Airbus": Plane,
  "Space & Satellites": Rocket,
  "Robot / Humanoid": Bot,
  "Fintech & Crypto": Coins,
};

function TickerChip({ t, accentVar }: { t: NameView; accentVar: string }) {
  const s = RATING_STYLE[t.rating];
  return (
    <a
      href={`${SOURCE_BASE}/universe/${t.ticker.toLowerCase()}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-surface/70 px-2 py-1 leading-none transition-all hover:-translate-y-0.5 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        s.chip,
      )}
      style={t.core ? { boxShadow: `inset 0 0 0 1.5px color-mix(in oklch, ${accentVar} 60%, transparent)` } : undefined}
      title={`${t.company || t.ticker} — ${t.rating}${t.core ? " · Core holding" : ""} · ${t.stance}`}
    >
      <StanceDot stance={t.stance} />
      <span className="tracking-tight">{t.ticker}</span>
      {s.glyph ? <span aria-hidden>{s.glyph}</span> : null}
    </a>
  );
}

/** Visual legend — shows the actual rating sizes, the ⭐ Core marker, and stance dots. */
function ChipLegend() {
  return (
    <div className="grid gap-4 rounded-2xl border border-border/50 bg-surface/30 p-4 text-xs sm:grid-cols-3">
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          🔥 Rating — how strongly he recommends it
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          {RATING_TIERS.map((r) => (
            <span key={r} className={cn("inline-flex items-center gap-1", RATING_STYLE[r].chip)}>
              {RATING_STYLE[r].glyph ? <span aria-hidden>{RATING_STYLE[r].glyph}</span> : null}
              {r}
            </span>
          ))}
        </div>
        <p className="text-muted-foreground">Chip size + 🔥 encode it — bigger &amp; hotter = a stronger call.</p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="inline-block size-3.5 rounded-[3px] bg-surface/80 ring-2 ring-primary/60" aria-hidden />
          Ring = Core holding
        </div>
        <p className="text-muted-foreground">
          Tickers wrapped in an accent ring are his most central, foundational positions — the handful of names the whole
          thesis hangs on.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">● Stance — his direction</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {STANCE_LEGEND.map((s) => (
            <span key={s.stance} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <StanceDot stance={s.stance} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ theme, usOnly, hero }: { theme: ThemeGroup; usOnly: boolean; hero?: boolean }) {
  const Icon = THEME_ICON[theme.name];
  const accentVar = THEME_ACCENT_VAR[theme.name];
  const shown = theme.names.filter((n) => (usOnly ? n.usInvestable : true));
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-border/60 bg-surface/30 p-4",
        hero && "bg-surface/40 sm:p-5",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklch, ${accentVar} 16%, transparent)` }}
        >
          <Icon className="size-4" style={{ color: accentVar }} aria-hidden />
        </span>
        <h3 className="flex-1 text-sm font-semibold leading-tight tracking-tight">{theme.name}</h3>
        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {shown.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No {usOnly ? "US-investable " : ""}names in this theme.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((t) => (
            <TickerChip key={t.ticker} t={t} accentVar={accentVar} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ThemeConstellation({ themes }: { themes: ThemeGroup[] }) {
  const reduce = useReducedMotion();
  const [usOnly, setUsOnly] = useState(true);

  const hero = themes[0];
  const rest = themes.slice(1);

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label="Investment universe by theme"
      className="glass card-elevated rounded-3xl border border-border/60 p-5 sm:p-6"
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">The universe, in 7 themes</h2>
          <p className="text-xs text-muted-foreground">Every name he tracks, grouped by theme — read each chip with the legend below.</p>
        </div>
        <button
          type="button"
          onClick={() => setUsOnly((v) => !v)}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            usOnly
              ? "border-border/60 bg-surface/40 text-muted-foreground hover:text-foreground"
              : "border-primary/40 bg-primary/10 text-primary",
          )}
          aria-pressed={!usOnly}
        >
          <span className={cn("relative inline-block size-3.5 rounded-full border", usOnly ? "border-border" : "border-primary")}>
            <span className={cn("absolute inset-0.5 rounded-full", usOnly ? "bg-transparent" : "bg-primary")} />
          </span>
          {usOnly ? "US-investable only" : "Including foreign & ADRs"}
        </button>
      </header>

      <div className="mb-5">
        <ChipLegend />
      </div>

      {hero ? (
        <div className="mb-4">
          <ThemeCard theme={hero} usOnly={usOnly} hero />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((theme, idx) => (
          <motion.div
            key={theme.name}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.4, delay: Math.min(idx * 0.04, 0.2), ease: "easeOut" }}
          >
            <ThemeCard theme={theme} usOnly={usOnly} />
          </motion.div>
        ))}
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground/80">
        Theme membership is keyword-classified from each name&apos;s thesis (the source resolves it client-side).
      </p>
    </motion.section>
  );
}
