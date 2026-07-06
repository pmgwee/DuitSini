import Link from "next/link";
import { ArrowRight, CalendarDays, LayoutDashboard, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 py-20 text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-3 py-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        Premium subscription management
      </div>

      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
        Every subscription, trial, and renewal — calmly under control.
      </h1>

      <p className="mt-5 max-w-xl text-base text-muted-foreground text-balance">
        Track recurring bills on a beautiful calendar, get reminded before trials
        convert, and watch your spending with clarity. Plus a personal dashboard for
        Claude usage, music, and time.
      </p>

      <div className="mt-9 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" className="gap-2">
          <Link href="/subscriptions">
            <CalendarDays className="size-4" />
            Open Subscriptions
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary" className="gap-2">
          <Link href="/dashboard">
            <LayoutDashboard className="size-4" />
            Open Dashboard
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </main>
  );
}
