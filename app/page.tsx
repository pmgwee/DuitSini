import Link from "next/link";
import { Activity, CalendarDays, Sparkles, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVideo } from "@/components/hero-video";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** The three core surfaces, in the same order as the in-app sidebar. */
const CORE_FEATURES = [
  { href: "/ai-usage", label: "AI Usage", icon: Activity },
  { href: "/stocks", label: "Stocks", icon: TrendingUp },
  { href: "/bills", label: "Bills", icon: CalendarDays },
] as const;

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const authed = Boolean(user);

  // Authed users jump straight into the feature; others land on the passwordless
  // sign-in, where `next` returns them to the page they actually picked.
  const hrefFor = (path: string) => (authed ? path : `/login?next=${path}`);

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
          <Sparkles className="size-3.5 text-primary" />
          Your day-to-day financing platform
        </div>

        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance text-white text-shadow-[0_2px_14px_rgba(0,0,0,0.7)] sm:text-6xl">
          Every ringgit and every token — calmly under control.
        </h1>

        <p className="mt-5 max-w-2xl text-balance text-base text-white/90 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          Three money surfaces, one calm place: the{" "}
          <strong className="font-semibold text-white">bills</strong> you&apos;re committed
          to, what your <strong className="font-semibold text-white">AI tools</strong> are
          burning, and what the{" "}
          <strong className="font-semibold text-white">market</strong> is doing — every
          figure in Ringgit.
        </p>

        {/* Three core surfaces, each deep-linking straight into the app (or through
            sign-in with `next` preserved, so the click still lands where intended). */}
        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          {CORE_FEATURES.map((f, i) => (
            <Button
              key={f.href}
              asChild
              size="lg"
              variant={i === 0 ? "default" : "secondary"}
              className="gap-2"
            >
              <Link href={hrefFor(f.href)}>
                <f.icon className="size-4" />
                {f.label}
              </Link>
            </Button>
          ))}
        </div>

        {!authed ? (
          <p className="mt-5 text-xs text-white/80 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
            Free while in beta · sign in with Google or email
          </p>
        ) : null}
      </div>
    </main>
  );
}
