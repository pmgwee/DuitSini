import Link from "next/link";
import type { ReactNode } from "react";

/** Support address shown in the consent screen (User support email). */
const SUPPORT_EMAIL = "ngxiaohao123@gmail.com";

/**
 * Shared shell for the public legal pages (Privacy Policy, Terms of Service).
 *
 * These pages live OUTSIDE the `(app)` route group and are NOT in the auth
 * middleware's PROTECTED_PREFIXES, so they load without a session — required
 * for Google OAuth verification, whose reviewers must be able to open the
 * privacy-policy and terms links straight from the consent screen with no
 * login.
 *
 * Styling uses arbitrary-variant selectors on the body wrapper so the pages
 * can be written as plain semantic HTML (`<h2>`, `<p>`, `<ul>`, `<a>`) and
 * stay consistent without a typography plugin.
 */
export function LegalPage({
  title,
  updatedAt,
  lead,
  children,
}: {
  title: string;
  updatedAt: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="relative min-h-dvh">
      {/* Minimal top bar — these pages have no app shell/sidebar/header. */}
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          DuitSini
        </Link>
        <Link
          href="/"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          ← Back to site
        </Link>
      </header>

      <article className="mx-auto max-w-3xl px-6 pb-24">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {updatedAt}
        </p>

        {lead ? (
          <p className="mt-6 text-base leading-relaxed text-foreground/85">
            {lead}
          </p>
        ) : null}

        <div className="mt-8 space-y-4 text-sm leading-relaxed text-foreground/85 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mt-10 [&_h2]:scroll-mt-20 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_li]:ml-1 [&_li]:mt-1.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
          {children}
        </div>

        <hr className="my-10 border-border/60" />
        <p className="text-sm text-muted-foreground">
          Questions about this page? Email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="font-medium text-primary underline underline-offset-2"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </article>
    </main>
  );
}
