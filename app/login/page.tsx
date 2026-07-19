import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to DuitSini with email or Google.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <div className="glass card-elevated rounded-3xl border border-border/60 p-8">
        <div className="flex flex-col items-center text-center">
          <div className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-5" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in or create your account to track your bills, your AI usage, and
            the market — all in Ringgit, all in one place.
          </p>
        </div>

        <div className="mt-7">
          <LoginForm next={next} error={error} />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground hover:underline">
            ← Back to home
          </Link>
        </p>
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Passwordless sign-in · Protected by Supabase Auth
      </p>
    </main>
  );
}
