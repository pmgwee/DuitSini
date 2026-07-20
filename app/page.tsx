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

      {/* Foreground content. `min-h-screen` (not a fixed h-screen) so the extra
          verification-required content (wordmark, purpose, data-use line) can
          scroll on short viewports instead of being clipped — clipping would
          hide the very text Google's reviewer needs to see. */}
      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-20 text-center lg:min-h-screen">
        {/* App wordmark — the literal "DuitSini" must be visibly present on the
            homepage to match the OAuth consent-screen app name (Google branding
            check). Plain <img> because next/image blocks SVG by default. */}
        <div className="flex items-center gap-2.5">
          <img
            src="/logos/duitsini-logo.svg"
            alt=""
            width={36}
            height={36}
            className="size-9 rounded-[10px] shadow-[0_4px_16px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
          />
          <span className="text-2xl font-bold tracking-tight text-white text-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            DuitSini
          </span>
        </div>

        <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-black/40 bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
          <Sparkles className="size-3.5 text-primary" />
          Your day-to-day financing platform
        </div>

        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance text-white text-shadow-[0_2px_14px_rgba(0,0,0,0.7)] sm:text-6xl">
          Every ringgit and every token — calmly under control.
        </h1>

        <p className="mt-5 max-w-2xl text-balance text-base text-white/90 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          <strong className="font-semibold text-white">DuitSini</strong> is a personal-finance
          dashboard that brings three money surfaces into one calm place: the{" "}
          <strong className="font-semibold text-white">bills</strong> and subscriptions
          you&apos;re committed to, what your{" "}
          <strong className="font-semibold text-white">AI tools</strong> are burning, and what
          the <strong className="font-semibold text-white">market</strong> is doing — every
          figure in Ringgit (MYR).
        </p>

        {/* Google data disclosure — required by Google's App Homepage policy: the
            homepage must explain how the app uses the Google user data it requests.
            Here the only Google data is read-only YouTube for the music player. */}
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-white/75 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          Sign in with Google. With your permission, DuitSini reads your YouTube
          playlists and liked videos — read-only — to play your own music in the
          built-in player.{" "}
          <Link
            href="/privacy"
            className="font-medium text-white/90 underline underline-offset-2 hover:text-white"
          >
            See the Privacy Policy
          </Link>
          .
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

      {/* Footer — kept low-profile over the video. The legal links must be
          publicly reachable for Google OAuth verification; surfacing them on
          the home page also makes them discoverable. */}
      <footer className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 py-4 text-center text-xs text-white/75 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
        <span>© {new Date().getFullYear()} DuitSini</span>
        <Link href="/privacy" className="transition-colors hover:text-white hover:underline">
          Privacy
        </Link>
        <Link href="/terms" className="transition-colors hover:text-white hover:underline">
          Terms
        </Link>
        <a
          href="mailto:ngxiaohao123@gmail.com"
          className="transition-colors hover:text-white hover:underline"
        >
          Contact
        </a>
      </footer>
    </main>
  );
}
