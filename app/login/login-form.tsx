"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Mail } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { buildCallbackUrl } from "@/lib/auth/redirect";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(120),
});
type EmailValues = z.infer<typeof emailSchema>;

type Status = "idle" | "submitting" | "sent" | "rate_limited";

/** The four-color Google "G" mark — lucide has no brand icons. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

export function LoginForm({
  next,
  error,
}: {
  next?: string;
  error?: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [googleLoading, setGoogleLoading] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmailValues>({ resolver: zodResolver(emailSchema), mode: "onSubmit" });

  const onSubmit = async ({ email }: EmailValues) => {
    setStatus("submitting");
    setSubmittedEmail(email);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: buildCallbackUrl(next) },
    });

    if (error) {
      // 429 = Supabase rate limit; everything else is treated as sent so we
      // never reveal whether the address is registered (enumeration-safe).
      setStatus(error.status === 429 ? "rate_limited" : "sent");
      return;
    }
    setStatus("sent");
  };

  const signInWithGoogle = async () => {
    setGoogleLoading(true);
    const supabase = createSupabaseBrowserClient();
    // The browser navigates to Google; `redirectTo` brings it back to the
    // PKCE callback, which exchanges the code server-side. The extra scope
    // lets the music widget read the user's YouTube (Music) playlists and
    // likes; `access_type=offline` + `prompt=consent` mint a refresh token.
    //
    // NOTE: recommendations do NOT come through this scope. Google removed YT
    // Music OAuth in Nov 2024, and the cookie workaround that replaced it was
    // retired too — the recommender now reads YouTube Music's public InnerTube
    // surfaces anonymously (see lib/music/sources.ts). This scope only powers
    // the official-API library/likes/playlist sync.
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildCallbackUrl(next),
        scopes: "https://www.googleapis.com/auth/youtube.readonly",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    setGoogleLoading(false);
  };

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-border/60 bg-surface/60 p-6 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-success/15 text-success ring-1 ring-success/25">
          <Mail className="size-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Check your email</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          If an account exists for{" "}
          <span className="font-medium text-foreground">{submittedEmail}</span>, a
          sign-in link is on its way. It expires shortly.
        </p>
        <p className="mt-3 text-xs text-muted-foreground/80">
          Open the link in this same browser — the secure sign-in code is bound
          to it.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-5 text-sm font-medium text-primary hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error === "callback" && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          That sign-in link is invalid or expired. Please try again.
        </div>
      )}
      {status === "rate_limited" && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Too many attempts — please wait a minute, then try again.
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register("email")}
              className={cn(
                "h-11 w-full rounded-xl border bg-input/50 pl-9 pr-3 text-sm outline-none transition-[border-color,box-shadow]",
                "placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40",
                errors.email ? "border-danger/60" : "border-border/60",
              )}
            />
          </div>
          {errors.email && (
            <span className="text-xs text-danger">{errors.email.message}</span>
          )}
        </label>

        <Button type="submit" size="lg" disabled={status === "submitting"} className="w-full">
          {status === "submitting" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Sending link…
            </>
          ) : (
            "Continue with email"
          )}
        </Button>
      </form>

      <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border/60" />
        or
        <span className="h-px flex-1 bg-border/60" />
      </div>

      <Button
        type="button"
        variant="secondary"
        size="lg"
        disabled={googleLoading}
        onClick={signInWithGoogle}
        className="w-full"
      >
        {googleLoading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <GoogleMark className="size-4" />
        )}
        Continue with Google
      </Button>

      <p className="mt-1 text-center text-xs text-muted-foreground">
        By continuing you agree to receive a one-time sign-in link. No password
        required.
      </p>
    </div>
  );
}
