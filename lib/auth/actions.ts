"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign out the current user. `scope: 'local'` revokes only THIS device's
 * refresh token (the Notion/Linear default) — other signed-in sessions (phone,
 * PWA install) keep working. A future account page can offer "sign out
 * everywhere" via `scope: 'global'`. Revoking server-side — not just deleting
 * the cookie — means a stolen cookie can no longer be replayed.
 */
export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
