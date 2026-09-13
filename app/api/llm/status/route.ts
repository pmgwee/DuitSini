import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { describeLlmConfig, isLlmConfigured } from "@/lib/ai/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which LLM is this deployment actually using?
 *
 * `LLM_MODEL` is read from the environment first and only falls back to the
 * code default, and Vercel binds environment variables to a deployment when it
 * is BUILT — so a variable changed in the dashboard has no effect until the
 * next deploy. That combination is silently wrong in a specific way: the repo
 * says one model, the dashboard says another, and the running deployment may
 * be using a third. Nothing surfaced the answer, so the only way to tell was
 * to infer it from latency.
 *
 * Returns the non-secret half of the config only — `describeLlmConfig` exists
 * precisely for this and never touches the API key. `configured` reports
 * whether a key is present without revealing anything about it.
 *
 * Sign-in required: this is a deployment detail, not public information.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const configured = isLlmConfigured();
  if (!configured) {
    // Every LLM feature degrades silently without a key, which is by design —
    // but "degraded on purpose" and "misconfigured" look identical from the UI.
    return NextResponse.json({ configured: false });
  }

  const { baseUrl, model } = describeLlmConfig();
  return NextResponse.json({ configured: true, baseUrl, model });
}
