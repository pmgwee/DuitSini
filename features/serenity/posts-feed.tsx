"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ExternalLink, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalyzedTweet, Stance, Topic } from "@/lib/serenity/types";
import { StanceDot, TRACKSERENITY_BASE } from "./shared";

const STANCE_CHIP: Record<Stance, string> = {
  BULLISH: "bg-success/12 text-success ring-1 ring-success/25",
  BEARISH: "bg-danger/12 text-danger ring-1 ring-danger/25",
  MIXED: "bg-muted text-muted-foreground ring-1 ring-border",
  NEUTRAL: "bg-surface/70 text-muted-foreground ring-1 ring-border/60",
};

export function PostsFeed({ feed }: { feed: AnalyzedTweet[] }) {
  const reduce = useReducedMotion();
  const [topic, setTopic] = useState<string>("all");

  // Topic counts across the whole feed (drives the dropdown + lets users see what's active).
  const topicCounts = useMemo(() => {
    const m = new Map<Topic, number>();
    for (const t of feed) for (const tp of t.topics) m.set(tp, (m.get(tp) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [feed]);

  const shown = topic === "all" ? feed : feed.filter((t) => t.topics.includes(topic as Topic));
  const top = shown.slice(0, 15);
  const llmCount = feed.filter((t) => t.llmAnalyzed).length;

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label="Latest Serenity posts on X"
      className="glass card-elevated rounded-3xl border border-border/60 p-5 sm:p-6"
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Latest from Serenity on X</h2>
          <p className="text-xs text-muted-foreground">
            Each post auto-tagged by topic + tickers (with stance).
            {llmCount > 0 ? ` ${llmCount} AI-analyzed with insight labels.` : " Add LLM_API_KEY for AI insight labels."}
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Filter</span>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="max-w-[14rem] rounded-full border border-border/60 bg-surface/60 px-3 py-1.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <option value="all">All topics ({feed.length})</option>
            {topicCounts.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </select>
        </label>
      </header>

      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground">No posts available right now.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {top.map((tw, i) => (
            <motion.li
              key={tw.id}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.025, 0.18), ease: "easeOut" }}
            >
              <article className="group block rounded-2xl border border-border/60 bg-surface/30 p-4 transition-colors hover:bg-surface/60">
                <div className="flex items-center justify-between gap-2">
                  <time className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {tw.displayTime || "recent"}
                  </time>
                  <a
                    href={tw.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    View on X <ExternalLink className="size-3" />
                  </a>
                </div>

                {tw.insight ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold leading-snug tracking-tight text-foreground">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    {tw.insight}
                  </p>
                ) : null}

                <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {tw.text}
                </p>

                {tw.topics.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {tw.topics.map((tp) => (
                      <button
                        key={tp}
                        type="button"
                        onClick={() => setTopic(tp)}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium leading-none ring-1 transition-colors",
                          topic === tp
                            ? "bg-primary/15 text-primary ring-primary/40"
                            : "bg-primary/5 text-primary/80 ring-primary/15 hover:bg-primary/10",
                        )}
                      >
                        {tp}
                      </button>
                    ))}
                  </div>
                ) : null}

                {tw.analyzedTickers.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {tw.analyzedTickers.map((tk) => (
                      <a
                        key={tk.ticker}
                        href={`${TRACKSERENITY_BASE}/stocks/${encodeURIComponent(tk.ticker)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${tk.ticker}${tk.company ? " — " + tk.company : ""} · ${tk.stance}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold leading-none",
                          STANCE_CHIP[tk.stance],
                        )}
                      >
                        <StanceDot stance={tk.stance} />
                        <span className="tracking-tight">{tk.ticker}</span>
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            </motion.li>
          ))}
        </ol>
      )}

      {shown.length > top.length ? (
        <p className="mt-3 text-center text-[11px] text-muted-foreground">{shown.length - top.length} more in this filter</p>
      ) : null}
    </motion.section>
  );
}
