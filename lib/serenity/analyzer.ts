import "server-only";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import { createChat, isZaiConfigured } from "@/lib/ai/zai";
import { tagTweetTopics, TOPICS } from "./topics";
import type { AnalyzedTicker, AnalyzedTweet, NameView, SerenityTweet, Stance, Topic } from "./types";

/**
 * Post analyzer — turns a raw Serenity X post into structured insight:
 *  - topics (from the 19-area taxonomy)
 *  - tickers resolved from BOTH $-cashtags and prose (e.g. "Apptronik"/"Tesla"),
 *    each with a contextual bullish/bearish stance
 *  - a one-line insight label
 *
 * Two paths:
 *  - LLM (Z.ai GLM-5.2): the rich path — generated insight, prose-ticker catch,
 *    contextual stance. Cached per-tweet (durable via unstable_cache so the heavy
 *    extraction runs ONCE per post, ever) + a per-instance in-memory map so the
 *    page can read results WITHOUT triggering an LLM call (latency only on the
 *    background cron warm, never on a visitor's page load).
 *  - Deterministic (no key / cache miss): topics via keyword+ticker rules, cashtag
 *    tickers with stance from the universe, no insight. Always works, instant.
 */

const TOPIC_LIST = TOPICS.join("\n- ");

const SYSTEM_PROMPT = `You analyze investing posts by Serenity (@aleabitoreddit, the "白毛股神" AI-hardware stock picker).
Return ONLY a JSON object, no prose, with this exact shape:
{
  "topics": [1-3 strings from the allowed topic list],
  "tickers": [{ "ticker": "SYMBOL", "company": "Company Name", "stance": "bullish" | "bearish" | "neutral" }],
  "insight": "one-line neutral summary, <=120 chars"
}
Allowed topics (use these EXACT strings):
- ${TOPIC_LIST}
Rules:
- topics: pick the 1-3 that best fit. Add "Macro & Market Analysis" when the post is about the broad market, rates, sentiment, a selloff/rally, or valuations.
- tickers: capture EVERY company or ticker mentioned — including names written WITHOUT a $ (e.g. "Apptronik", "Tesla", "Jabil", "Boston Dynamics"). Resolve to the trading symbol when known; for private/unknown firms use the company name as the ticker. "stance" is the post's tone toward THAT specific company.
- insight: concise, factual, no hype, no advice.`;

const extractSchema = z.object({
  topics: z.array(z.string()).default([]),
  tickers: z
    .array(
      z.object({
        ticker: z.string(),
        company: z.string().optional(),
        stance: z.string(),
      }),
    )
    .default([]),
  insight: z.string().default(""),
});
type LlmExtract = z.infer<typeof extractSchema>;

function asStance(s: string): Stance {
  const v = (s || "").toLowerCase();
  if (v.startsWith("bull")) return "BULLISH";
  if (v.startsWith("bear")) return "BEARISH";
  if (v.startsWith("neutral") || v.startsWith("mixed")) return "MIXED";
  return "NEUTRAL";
}

/** Stable short hash of the text, so a post edit re-analyzes. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** The expensive LLM call, cached durably (per post text) via the platform Data Cache. */
const llmExtractCached = unstable_cache(
  async (key: string, text: string, cashtags: string[]): Promise<LlmExtract> => {
    const user = `Post:\n"""${text}"""\n\n$-tickers present: ${cashtags.join(", ") || "(none)"}`;
    const raw = await createChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      thinkingDisabled: true,
      json: true,
      temperature: 0,
      maxTokens: 700,
    });
    const parsed = extractSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("bad LLM json");
    return parsed.data;
  },
  ["serenity-tweet-extract"],
  { revalidate: 604800, tags: ["serenity-analysis"] },
);

// Per-instance fast-peek layer (populated by the cron warm; read by the page).
const analyzedMap = new Map<string, AnalyzedTweet>();

/** Deterministic fallback — topics via rules, cashtag tickers + universe stance, no insight. */
export function deterministicAnalysis(
  tweet: SerenityTweet,
  byTicker: Map<string, NameView>,
): AnalyzedTweet {
  const topics = tagTweetTopics(tweet.text, tweet.cashtags, byTicker);
  const analyzedTickers: AnalyzedTicker[] = tweet.cashtags.map((tk) => {
    const v = byTicker.get(tk.toUpperCase());
    return { ticker: tk.toUpperCase(), company: v?.company, stance: v?.stance ?? "NEUTRAL" };
  });
  return { ...tweet, topics, insight: "", analyzedTickers, llmAnalyzed: false };
}

function mergeExtract(
  tweet: SerenityTweet,
  extract: LlmExtract,
  byTicker: Map<string, NameView>,
): AnalyzedTweet {
  const valid = new Set<Topic>(TOPICS);
  const topics = (extract.topics ?? []).filter((t): t is Topic => valid.has(t as Topic));
  const detTopics = tagTweetTopics(tweet.text, tweet.cashtags, byTicker);
  const mergedTopics = [...new Set([...topics, ...detTopics])];
  // Re-order to canonical taxonomy order.
  const ordered = TOPICS.filter((t) => mergedTopics.includes(t));

  const seen = new Set<string>();
  const analyzedTickers: AnalyzedTicker[] = [];
  for (const t of extract.tickers ?? []) {
    const ticker = (t.ticker || "").toUpperCase().trim();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const v = byTicker.get(ticker);
    analyzedTickers.push({
      ticker,
      company: t.company || v?.company,
      stance: asStance(t.stance),
    });
  }
  // Ensure raw $-cashtags are represented even if the LLM missed one.
  for (const tk of tweet.cashtags) {
    const up = tk.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    const v = byTicker.get(up);
    analyzedTickers.push({ ticker: up, company: v?.company, stance: v?.stance ?? "NEUTRAL" });
  }

  return {
    ...tweet,
    topics: ordered.length ? ordered : detTopics,
    insight: (extract.insight || "").trim(),
    analyzedTickers,
    llmAnalyzed: true,
  };
}

/**
 * Warm a tweet's analysis (cron-only): LLM if configured (cached durably), else
 * deterministic. Stores the result in the per-instance peek map.
 */
export async function warmAnalysis(
  tweet: SerenityTweet,
  byTicker: Map<string, NameView>,
): Promise<AnalyzedTweet> {
  const existing = analyzedMap.get(tweet.id);
  if (existing) return existing;

  let result: AnalyzedTweet;
  if (isZaiConfigured()) {
    try {
      const extract = await llmExtractCached(shortHash(tweet.text), tweet.text, tweet.cashtags);
      result = mergeExtract(tweet, extract, byTicker);
    } catch (err) {
      console.error("[serenity/analyzer] LLM failed, falling back:", (err as Error)?.message ?? err);
      result = deterministicAnalysis(tweet, byTicker);
    }
  } else {
    result = deterministicAnalysis(tweet, byTicker);
  }
  analyzedMap.set(tweet.id, result);
  return result;
}

/**
 * Read a tweet's analysis for the PAGE — never triggers an LLM call. Returns the
 * warmed (LLM) analysis if the cron populated it, else the deterministic baseline.
 */
export function getAnalysis(
  tweet: SerenityTweet,
  byTicker: Map<string, NameView>,
): AnalyzedTweet {
  return analyzedMap.get(tweet.id) ?? deterministicAnalysis(tweet, byTicker);
}
