"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bot, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NameView, SerenityTweet } from "@/lib/serenity/types";
import { RATING_STYLE } from "./shared";

// Same keyword set as the robot-vision section — surfaces his humanoid/robot posts.
const ROBOT_RE = /robot|humanoid|agility|apptronik|boston dynamics|atlas|optimus|actuator|harmonic/i;

export function PostsFeed({ feed, universe }: { feed: SerenityTweet[]; universe: NameView[] }) {
  const reduce = useReducedMotion();
  const [robotOnly, setRobotOnly] = useState(false);
  const top = (robotOnly ? feed.filter((t) => ROBOT_RE.test(t.text || "")) : feed).slice(0, 10);

  // ticker → view, to look up stance + rating for each cashtag.
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
      aria-label="Latest Serenity posts on X"
      className="glass card-elevated rounded-3xl border border-border/60 p-5 sm:p-6"
    >
      <header className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Latest from Serenity on X</h2>
            <p className="text-xs text-muted-foreground">
              His recent posts in real time — synced 1:1 from trackserenity.com. Green chips = tickers he&apos;s bullish on.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRobotOnly((v) => !v)}
            aria-pressed={robotOnly}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              robotOnly
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/60 bg-surface/40 text-muted-foreground hover:text-foreground",
            )}
          >
            <Bot className="size-3.5" />
            {robotOnly ? "Robot posts" : "All posts"}
          </button>
        </div>
      </header>

      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent posts available right now.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {top.map((tw, i) => {
            const tagged = tw.cashtags
              .map((tk) => byTicker.get(tk.toUpperCase()))
              .filter((n): n is NameView => Boolean(n));
            // Show every bullish ticker (no US filter, no "+N other" collapse)…
            const bullish = tagged.filter((n) => n.stance === "BULLISH");
            // …and the rest as muted labels so nothing mentioned is hidden.
            const rest = tagged.filter((n) => n.stance !== "BULLISH");

            return (
              <motion.li
                key={tw.id}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: Math.min(i * 0.03, 0.2), ease: "easeOut" }}
              >
                <a
                  href={tw.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block rounded-2xl border border-border/60 bg-surface/30 p-4 transition-colors hover:bg-surface/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <time className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {tw.displayTime || "recent"}
                    </time>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-primary">
                      View on X <ExternalLink className="size-3" />
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                    {tw.text}
                  </p>

                  {tagged.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {bullish.length > 0 ? (
                        <span className="text-[10px] font-medium uppercase tracking-wider text-success/80">Bullish</span>
                      ) : null}
                      {bullish.map((n) => {
                        const s = RATING_STYLE[n.rating];
                        return (
                          <span
                            key={n.ticker}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md bg-success/12 px-1.5 py-0.5 leading-none ring-1 ring-success/20",
                              s.chip,
                            )}
                            title={`${n.company || n.ticker} — ${n.rating}${n.core ? " · Core" : ""}`}
                          >
                            {s.glyph ? <span aria-hidden>{s.glyph}</span> : null}
                            <span className="font-semibold tracking-tight">{n.ticker}</span>
                          </span>
                        );
                      })}
                      {rest.length > 0 ? (
                        <>
                          {bullish.length > 0 ? <span className="text-[10px] text-muted-foreground/50">·</span> : null}
                          {rest.map((n) => (
                            <span key={n.ticker} className="text-[11px] text-muted-foreground">
                              {n.ticker}
                            </span>
                          ))}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </a>
              </motion.li>
            );
          })}
        </ol>
      )}
    </motion.section>
  );
}
