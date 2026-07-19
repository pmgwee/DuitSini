import { z } from "zod";

/**
 * Zod schemas for the raw objects lifted out of serenitytrades.com's RSC payload.
 *
 * The discriminative numeric/string fields are REQUIRED (no default) so that
 * malformed or partial rows — e.g. /performance's `{"ticker":"SIVEF","reason":
 * "no FMP data"}` — fail `safeParse` and are dropped instead of becoming bogus
 * zero-filled holdings. Everything else gets a sensible default so a renamed or
 * missing ancillary field never breaks the whole parse (RSC is an unstable
 * internal format; this is the defensive layer against it).
 */
export const nameSchema = z.object({
  ticker: z.string().min(1),
  company: z.string().default(""),
  region: z.string().default("Other"),
  likely_owned: z.string().default("NO"),
  owned: z.boolean().default(false),
  stated_weight_pct: z.number().nullable().default(null),
  // Required — these are the fields the whole view depends on:
  centrality: z.string(),
  conviction: z.number(),
  stance: z.string(),
  tweet_count: z.number().default(0),
  thesis_summary: z.string().default(""),
});
export type NameRaw = z.infer<typeof nameSchema>;

export const holdingSchema = z.object({
  ticker: z.string().min(1),
  company: z.string().default(""),
  fmp_symbol: z.string().default(""),
  region: z.string().default("Other"),
  // Required — a row without these (e.g. "no FMP data") is not a holding:
  conviction: z.number(),
  weight_conviction: z.number(),
  weight_equal: z.number(),
  return_pct: z.number(),
});
export type HoldingRaw = z.infer<typeof holdingSchema>;
