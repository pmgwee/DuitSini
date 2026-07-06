"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign out the current user. Calls Supabase to revoke the session server-side
 * (default scope = this device's session), then clears the auth cookies and
 * sends the user to the login page. Revoking — not just deleting the cookie —
 * means a stolen cookie can no longer be replayed.
 */
export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
