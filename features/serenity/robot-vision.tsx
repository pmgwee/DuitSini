"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NameView } from "@/lib/serenity/types";
import { RATING_STYLE, StanceDot, TRACKSERENITY_BASE } from "./shared";

/**
 * Serenity's robot / humanoid vision.
 *
 * The thematic content (OEM × builder pairings, the Boston Dynamics/Atlas Korean
 * supply chain) is curated verbatim from his July-2026 X posts — reference content
 * he articulated, not our interpretation. Per-ticker overlays (rating / stance) are
 * joined live from the serenitytrades universe where available. His actual robot
 * posts live in the main "Latest from Serenity on X" feed (use its Robot filter).
 */

interface OemRow {
  oem: string;
  ticker: string | null; // investable ticker to surface (null = private)
  tickerNote?: string; // e.g. "via Jabil"
  builders: string;
}
const HUMANOID_OEMS: OemRow[] = [
  { oem: "Tesla Optimus", ticker: "TSLA", builders: "at-scale humanoid" },
  { oem: "Agility Robotics", ticker: "CCXI", builders: "× Foxconn, Toyota" },
  { oem: "Apptronik", ticker: "JBL", tickerNote: "via Jabil", builders: "× Jabil, Mercedes" },
  { oem: "Figure AI", ticker: null, builders: "× BMW (private)" },
  { oem: "Boston Dynamics", ticker: null, builders: "× Hyundai (private)" },
  { oem: "Highlanders / 1X", ticker: null, builders: "× Mitsubishi (private)" },
];

const COMPONENT_PICKS = ["NVDA", "AEVA", "OUST"];

const ATLAS_KOREA: { ticker: string; name: string; role: string }[] = [
  { ticker: "010690", name: "Hwashin", role: "body / arms / legs" },
  { ticker: "373220", name: "LG Energy", role: "battery" },
  { ticker: "307950", name: "Hyundai Autoever", role: "integration" },
];

function TickerTag({ ticker, v }: { ticker: string; v: NameView | undefined }) {
  const s = v ? RATING_STYLE[v.rating] : null;
  return (
    <a
      href={`${TRACKSERENITY_BASE}/stocks/${ticker}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`${ticker}${v?.company ? " — " + v.company : ""}${v ? " · " + v.rating + " · " + v.stance : ""}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-surface/80 px-2 py-1 leading-none ring-1 ring-border/60 transition-all hover:-translate-y-0.5 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        v?.core && "ring-2 ring-primary/60",
        v ? s!.chip : "text-xs font-medium text-muted-foreground",
      )}
    >
      {v ? <StanceDot stance={v.stance} /> : null}
      <span className="font-semibold tracking-tight">{ticker}</span>
      {s?.glyph ? <span aria-hidden>{s.glyph}</span> : null}
    </a>
  );
}

export function RobotVision({ universe }: { universe: NameView[] }) {
  const reduce = useReducedMotion();
  const byTicker = useMemo(() => {
    const m = new Map<string, NameView>();
    for (const n of universe) m.set(n.ticker, n);
    return m;
  }, [universe]);

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label="Serenity's robot vision"
      className="glass card-elevated rounded-3xl border border-border/60 p-5 sm:p-6"
    >
      <header className="mb-4 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-xl bg-primary/15 text-primary">
          <Bot className="size-4.5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Serenity&apos;s robot vision</h2>
          <p className="text-xs text-muted-foreground">
            Humanoid inflection — his OEM × builder map + picks-and-shovels, curated from his X posts.
          </p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Humanoid OEMs × builders */}
        <div className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-surface/30 p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Humanoid OEMs × their builders
          </h3>
          <ul className="flex flex-col gap-2">
            {HUMANOID_OEMS.map((o) => (
              <li key={o.oem} className="flex flex-wrap items-center gap-2">
                <span className="w-32 shrink-0 text-sm font-medium">{o.oem}</span>
                {o.ticker ? <TickerTag ticker={o.ticker} v={byTicker.get(o.ticker)} /> : null}
                {o.tickerNote ? <span className="text-[10px] text-muted-foreground/70">{o.tickerNote}</span> : null}
                {!o.ticker ? <span className="text-[11px] text-muted-foreground/60">private</span> : null}
                <span className="text-[11px] text-muted-foreground">· {o.builders}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Components + Korean Atlas supply chain */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-surface/30 p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Picks &amp; shovels — compute &amp; perception
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {COMPONENT_PICKS.map((tk) => (
                <TickerTag key={tk} ticker={tk} v={byTicker.get(tk)} />
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Robot-fleet compute ($NVDA) and Western lidar ($AEVA, $OUST) — he reads Hesai&apos;s US scrutiny as a tailwind.
            </p>
          </div>

          <div className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-surface/30 p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Boston Dynamics / Atlas — Korean supply chain
            </h3>
            <ul className="flex flex-col gap-1.5">
              {ATLAS_KOREA.map((k) => (
                <li key={k.ticker} className="flex flex-wrap items-center gap-2">
                  <TickerTag ticker={k.ticker} v={byTicker.get(k.ticker)} />
                  <span className="text-[11px] text-muted-foreground">
                    {k.name} · {k.role}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground/80">
        Robot map curated from Serenity&apos;s July-2026 X posts · live conviction/stance from serenitytrades · tickers
        link to trackserenity.com thesis pages. His robot posts stream into the &ldquo;Latest from Serenity on X&rdquo;
        feed (use its Robot filter).
      </p>
    </motion.section>
  );
}
