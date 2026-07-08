import Link from "next/link";
import { ArrowRight, CalendarDays, LayoutDashboard, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVideo } from "@/components/hero-video";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const authed = Boolean(user);

  // Authed users jump straight into the app; others start at the passwordless
  // sign-in. `next` returns them to the page they picked after authenticating.
  const primaryHref = authed ? "/subscriptions" : "/login?next=/subscriptions";
  const secondaryHref = authed ? "/dashboard" : "/login?next=/dashboard";

  return (
    <main className="relative w-full overflow-hidden bg-background">
      {/* Background video — fullscreen, autoplay/muted/loop/playsinline, no audio.
          Decorative: aria-hidden + pointer-events-none so it never steals focus or
          clicks from the foreground content. */}
      <HeroVideo src="/upscaled-video%20(1).mp4" />
      {/* Video is at 100% opacity — no scrim. Foreground legibility comes from
          white text + per-element drop-shadows, and a dark badge chip. */}

      {/* Foreground content (scrolls on small screens, locks to the viewport on lg). */}
      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-20 text-center lg:h-screen lg:overflow-hidden">
        <div className="inline-flex items-center gap-2 rounded-full border border-black/40 bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
          <Laptop className="size-3.5 text-primary" />
          Premium subscription management
        </div>

        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance text-white text-shadow-[0_2px_14px_rgba(0,0,0,0.7)] sm:text-6xl">
          Every subscription, trial, and renewal — calmly under control.
        </h1>

        <p className="mt-5 max-w-2xl text-balance text-base text-white/90 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          Track recurring bills on a beautiful calendar, get reminded before trials
          convert, and watch your spending with clarity. Plus a personal dashboard for
          Claude usage, music, and time.
        </p>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" className="gap-2">
            <Link href={primaryHref}>
              <CalendarDays className="size-4" />
              {authed ? "Open Subscriptions" : "Get started"}
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary" className="gap-2">
            <Link href={secondaryHref}>
              <LayoutDashboard className="size-4" />
              {authed ? "Open Dashboard" : "Sign in"}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
