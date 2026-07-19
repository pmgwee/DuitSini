import { cn } from "@/lib/utils";
import type { Rating, SerenityTheme, Stance } from "@/lib/serenity/types";

/** Persistent, on-every-page attribution for the agreed live-aggregator posture. */
export const ATTRIBUTION =
  "Derived from serenitytrades.com & trackserenity.com — independent reconstructions of @aleabitoreddit's public posts. Price data via FMP. Not affiliated. Not investment advice.";

export const SOURCE_BASE = "https://serenitytrades.com";
export const TRACKSERENITY_BASE = "https://www.trackserenity.com";

/** +200.9% / -25.9% / 0% — drops a trailing .0, keeps one decimal otherwise. */
export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1).replace(/\.0$/, "")}%`;
}

// ── Rating (analyst-style, from conviction) ────────────────────────────────────────────
// The chip's SIZE + 🔥 encode the rating; this is the only "how strongly does he
// recommend it" signal an investor needs to scan.
export const RATING_STYLE: Record<Rating, { chip: string; glyph: string; blurb: string }> = {
  "Strong Buy": {
    chip: "text-sm font-bold text-foreground",
    glyph: "🔥",
    blurb: "his strongest calls",
  },
  Buy: {
    chip: "text-sm font-semibold text-foreground",
    glyph: "",
    blurb: "he likes it",
  },
  Hold: {
    chip: "text-xs font-medium text-muted-foreground",
    glyph: "",
    blurb: "on the shelf",
  },
  Watch: {
    chip: "text-xs font-normal text-muted-foreground/60",
    glyph: "",
    blurb: "just watching",
  },
};

const RATING_ORDER: Rating[] = ["Strong Buy", "Buy", "Hold", "Watch"];
export const RATING_TIERS = RATING_ORDER;

/** Small inline rating badge for the holdings list / detail rows. */
export function RatingChip({ rating, className }: { rating: Rating; className?: string }) {
  const s = RATING_STYLE[rating];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
        rating === "Strong Buy"
          ? "bg-success/15 text-success ring-1 ring-success/30"
          : rating === "Buy"
            ? "bg-primary/10 text-primary ring-1 ring-primary/25"
            : rating === "Hold"
              ? "bg-muted text-muted-foreground ring-1 ring-border"
              : "bg-muted/60 text-muted-foreground/70 ring-1 ring-border/60",
        className,
      )}
    >
      {s.glyph ? <span aria-hidden>{s.glyph}</span> : null}
      {rating}
    </span>
  );
}

// ── Stance ─────────────────────────────────────────────────────────────────────────────
const STANCE_BG: Record<Stance, string> = {
  BULLISH: "bg-success",
  MIXED: "bg-warning",
  NEUTRAL: "bg-muted-foreground/60",
  BEARISH: "bg-danger",
};
const STANCE_LABEL: Record<Stance, string> = {
  BULLISH: "Bullish",
  MIXED: "Mixed",
  NEUTRAL: "Neutral",
  BEARISH: "Bearish",
};

export function StanceDot({ stance, className }: { stance: Stance; className?: string }) {
  return (
    <span className={cn("inline-block size-2 rounded-full", STANCE_BG[stance], className)} title={STANCE_LABEL[stance]} />
  );
}

export const STANCE_LEGEND: { stance: Stance; label: string }[] = [
  { stance: "BULLISH", label: "Bullish" },
  { stance: "MIXED", label: "Mixed" },
  { stance: "NEUTRAL", label: "Neutral" },
  { stance: "BEARISH", label: "Bearish" },
];

// ── Theme accent (CSS var per theme, theme-aware via light/dark tokens) ─────────────────
export const THEME_ACCENT_VAR: Record<SerenityTheme, string> = {
  "AI photonics / optical interconnect (CPO)": "var(--cat-ai)",
  "Memory / NAND-DRAM supercycle": "var(--cat-cloud)",
  "Advanced packaging & semicap chokepoints": "var(--cat-productivity)",
  "AI power / grid bottleneck": "var(--cat-utilities)",
  Neoclouds: "var(--cat-saas)",
  "Defense / drones & space": "var(--cat-gaming)",
  "Fintech / crypto & high-margin compounders": "var(--cat-finance)",
};

/** Return-color for an SVG element (red ↔ green via theme tokens). */
export function returnFill(r: number): string {
  if (r > 0.01) return "var(--success)";
  if (r < -0.01) return "var(--danger)";
  return "var(--muted-foreground)";
}
