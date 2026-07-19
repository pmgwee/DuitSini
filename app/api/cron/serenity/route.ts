import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getSerenityData, warmSerenityAnalysis } from "@/lib/serenity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold-cache warm can analyze the whole feed (first run); 120s is headroom.
export const maxDuration = 120;

/**
 * Headless warmer — the proactive half of the freshness pipeline.
 *
 * The page's reads of Serenity's X feed (trackserenity signals.json) are cached
 * with `next: { revalidate: 300, tags: ["serenity-feed"] }`, which is LAZY: the
 * cache only refreshes when a visitor hits the page after the TTL. Under zero
 * traffic the feed would go stale. This scheduled job closes that gap — it purges
 * the tagged cache (`revalidateTag`) then immediately re-reads (`getSerenityData`)
 * so a fresh feed is re-cached on a fixed schedule, regardless of who's visiting.
 * Every audience member then sees ≤~10-min-old X posts even if they're the first
 * visitor after a quiet spell.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron injects it; same
 * secret as the reminders/reports crons). 401 otherwise. The warm never throws to
 * the scheduler — a trackserenity hiccup returns a structured 200 with stale=true.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    // Purge the X-feed cache so the next read pulls fresh from trackserenity.
    revalidateTag("serenity-feed");
    // Warm every feed tweet's analysis (LLM where configured, cached durably) so
    // the page's peek-only read has enriched insight/topics/tickers ready.
    const warmed = await warmSerenityAnalysis();
    // Also prime the aggregated payload the page/api serves.
    const data = await getSerenityData();
    return NextResponse.json({
      ok: true,
      warmedAt: data.fetchedAt,
      feedUpdatedAt: data.feedUpdatedAt,
      tweets: data.feed.length,
      watchlist: data.watchlist.length,
      analyzed: warmed.warmed,
      llm: warmed.llm,
      stale: data.stale,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "warm failed";
    console.error("[cron/serenity] warm failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  }
}
