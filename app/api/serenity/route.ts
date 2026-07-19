import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSerenityData } from "@/lib/serenity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin read of the Serenity snapshot for the dashboard's client-side
 * polling. Authed by the session cookie (same pattern as /api/claude-usage/live);
 * the underlying fetches are served from the platform Data Cache (revalidate),
 * so this is cheap and deduped across users/instances.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const data = await getSerenityData();
  return NextResponse.json(data);
}
