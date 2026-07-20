import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern your use of DuitSini, including acceptable use and third-party services.",
};

const UPDATED = "20 July 2026";

/**
 * Public Terms of Service — required for Google OAuth sensitive-scope
 * verification. Hosted on the authorised domain and reachable without a
 * session.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updatedAt={UPDATED}
      lead={
        <>
          Welcome to DuitSini. These Terms of Service (&ldquo;Terms&rdquo;)
          govern your access to and use of the DuitSini web application at{" "}
          <a href="https://duitsini.vercel.app/">duitsini.vercel.app</a> (the
          &ldquo;Service&rdquo;). By creating an account or using the Service,
          you agree to these Terms.
        </>
      }
    >
      <h2>1. The Service</h2>
      <p>
        DuitSini is a personal-finance dashboard for tracking recurring bills
        and subscriptions, monitoring your AI-usage, and following the market.
        The Service is currently in beta and provided on an &ldquo;as
        is&rdquo; basis.
      </p>

      <h2>2. Your account</h2>
      <p>
        You are responsible for keeping your sign-in credentials and session
        secure and for all activity under your account. You agree to provide
        accurate information and to be at least 16 years old, or the age of
        digital consent in your jurisdiction.
      </p>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service for any unlawful purpose.</li>
        <li>
          Attempt to access another user&rsquo;s data, reverse-engineer, or
          disrupt the Service.
        </li>
        <li>
          Misuse the optional usage-sharer or any integration to bypass rate
          limits or terms of a third-party service.
        </li>
        <li>Introduce malware or attempt to overload the Service.</li>
      </ul>

      <h2>4. Third-party services &amp; Google APIs</h2>
      <p>
        The Service integrates with third-party services including Google
        (sign-in and the YouTube Data API), Supabase, Vercel, and — where you
        enable it — Telegram. Your use of those services is also subject to
        their terms and policies, including{" "}
        <a href="https://policies.google.com/terms">Google&rsquo;s Terms</a> and{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        .
      </p>
      <p>
        Where the Service accesses Google APIs, that access is limited to
        providing the feature to you (for example, reading your own YouTube
        playlists for the music widget) and complies with Google&rsquo;s
        Limited Use requirements.
      </p>

      <h2>5. Your content</h2>
      <p>
        You retain ownership of the data you enter. You grant DuitSini a
        limited licence to process that data solely to provide the Service to
        you.
      </p>

      <h2>6. No warranties</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as
        available&rdquo; without warranties of any kind. We do not guarantee
        that the figures, reminders, reports, or analyses will be accurate,
        complete, or timely — always verify important financial decisions with
        your own records or a qualified professional.
      </p>

      <h2>7. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, DuitSini shall not be liable
        for any indirect, incidental, or consequential damages, or any loss of
        data or profits, arising out of your use of the Service.
      </p>

      <h2>8. Termination</h2>
      <p>
        You may stop using the Service and delete your account at any time by
        contacting support. We may suspend or terminate access if you breach
        these Terms.
      </p>

      <h2>9. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. The &ldquo;Last
        updated&rdquo; date above reflects the current version. Continued use
        after a change constitutes acceptance.
      </p>

      <h2>10. Governing law</h2>
      <p>
        These Terms are governed by the laws of Malaysia, without regard to
        conflict-of-laws principles.
      </p>

      <h2>11. Contact</h2>
      <p>
        Questions about these Terms? Email{" "}
        <a href="mailto:ngxiaohao123@gmail.com">ngxiaohao123@gmail.com</a>.
      </p>
    </LegalPage>
  );
}
