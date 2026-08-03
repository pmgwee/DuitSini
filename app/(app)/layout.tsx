import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";
import { ToastProvider } from "@/components/layout/toast-provider";
import { MusicPlayerProvider } from "@/features/dashboard/music/player-context";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Defense-in-depth on top of the middleware guard: never render the authed
  // shell without a server-validated user.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rawName = user.user_metadata?.full_name ?? user.user_metadata?.name;
  const fullName = typeof rawName === "string" ? rawName : null;

  // The player provider wraps the shell so the YouTube player (and its audio)
  // outlives navigation between app pages.
  return (
    <MusicPlayerProvider>
      <ToastProvider>
        <AppShell user={{ email: user.email ?? null, fullName }}>{children}</AppShell>
      </ToastProvider>
    </MusicPlayerProvider>
  );
}
