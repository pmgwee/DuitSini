import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How DuitSini collects, uses, and protects your personal information, including the limited YouTube data used by the music widget.",
};

const UPDATED = "20 July 2026";

/**
 * Public Privacy Policy — required for Google OAuth sensitive-scope
 * verification. Hosted on the authorised domain (duitsini.vercel.app) and
 * reachable without a session. The §4 "Google APIs / Limited Use" clause is
 * the one Google's reviewers specifically look for.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updatedAt={UPDATED}
      lead={
        <>
          This Privacy Policy explains what personal information DuitSini
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, how we use it, and the
          choices you have. It applies to the DuitSini web application at{" "}
          <a href="https://duitsini.vercel.app/">duitsini.vercel.app</a> (the
          &ldquo;Service&rdquo;).
        </>
      }
    >
      <h2>1. Who we are</h2>
      <p>
        DuitSini operates the Service — a personal-finance dashboard for
        tracking recurring bills and subscriptions, monitoring your AI-usage,
        and following the market, all presented in Ringgit (MYR). The developer
        responsible for your data can be reached at{" "}
        <a href="mailto:ngxiaohao123@gmail.com">ngxiaohao123@gmail.com</a>.
      </p>

      <h2>2. Information we collect</h2>
      <ul>
        <li>
          <strong>Account &amp; sign-in.</strong> When you sign in with Google,
          we receive your email address and the basic profile details Google
          shares with us. With passwordless email sign-in we receive only your
          email address.
        </li>
        <li>
          <strong>Content you enter.</strong> The subscriptions, bills,
          amounts, currencies, categories, providers, notes, reminders, and
          settings you add to the Service.
        </li>
        <li>
          <strong>AI usage you choose to share.</strong> If you install and run
          the optional DuitSini usage sharer, the Service receives your own
          Claude / GLM usage statistics and displays them on your dashboard.
          This only ever happens if you set it up, and only reflects your own
          usage.
        </li>
        <li>
          <strong>YouTube data via Google.</strong> When you sign in with
          Google, the Service requests read-only access to your YouTube account
          so it can display and play your own playlists and liked videos inside
          the music widget. This is described in detail in §4.
        </li>
        <li>
          <strong>Optional integrations.</strong> If you connect Telegram, we
          store your Telegram chat identifier so we can send the reminders and
          reports you request.
        </li>
        <li>
          <strong>Technical &amp; analytics.</strong> Basic aggregate,
          privacy-preserving analytics and server logs used to operate and
          secure the Service.
        </li>
      </ul>

      <h2>3. How we use your information</h2>
      <ul>
        <li>To provide the features of the Service to you.</li>
        <li>To authenticate you and keep your account secure.</li>
        <li>To provide support and respond to your requests.</li>
        <li>
          We do <strong>not</strong> use your information for advertising, and
          we do <strong>not</strong> sell it.
        </li>
      </ul>

      <h2>4. Your YouTube data &amp; Google APIs (Limited Use)</h2>
      <p>
        The Service uses Google APIs — specifically the YouTube Data API under
        the scope <code>youtube.readonly</code> — to read your playlists and
        liked videos so they can be shown and played in the music widget.
      </p>
      <p>
        DuitSini&rsquo;s use of information received from Google APIs adheres
        to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. In particular:
      </p>
      <ul>
        <li>
          We request only the minimum scope needed (read-only) and read only
          the data required to display your own music library.
        </li>
        <li>
          Your YouTube data is shown only to you and is never made public,
          shared, or sold.
        </li>
        <li>
          We do not use Google API data to serve advertising, to train models,
          or for any purpose other than providing the music feature to you.
        </li>
        <li>
          We do not transfer Google API data to any third party except as
          necessary to provide the feature to you.
        </li>
      </ul>
      <p>
        If you do not want the Service to access your YouTube account, sign in
        with email instead of Google — the rest of the Service works fully
        without this access. You can also revoke access at any time from your{" "}
        <a href="https://myaccount.google.com/permissions">
          Google account permissions
        </a>{" "}
        page.
      </p>

      <h2>5. How we share information</h2>
      <p>
        We do not sell your personal information. We share it only with the
        service providers that process data on our behalf to run the Service:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong> — authentication and database hosting.
        </li>
        <li>
          <strong>Vercel</strong> — web hosting and aggregate analytics.
        </li>
        <li>
          <strong>Google</strong> — Google sign-in (identity) and the YouTube
          Data API.
        </li>
      </ul>
      <p>
        These providers process data only to deliver the Service and under
        terms consistent with this policy. We may also disclose information
        when required to do so by law.
      </p>

      <h2>6. Data storage &amp; security</h2>
      <p>
        Your data is stored in Supabase (Singapore region). All traffic uses
        HTTPS. Each account is isolated with row-level security so you can only
        ever read your own rows, and access tokens that connect third-party
        features are scoped per user.
      </p>

      <h2>7. Data retention</h2>
      <p>
        We keep your information for as long as your account is active, and
        until you ask us to delete it. When you delete your account we remove
        your data from the active systems we control.
      </p>

      <h2>8. Your rights &amp; choices</h2>
      <ul>
        <li>Access, export, correct, or delete the personal data we hold.</li>
        <li>
          Withdraw Google access and the YouTube scope from your{" "}
          <a href="https://myaccount.google.com/permissions">
            Google account permissions
          </a>{" "}
          page.
        </li>
        <li>
          Request account or data deletion by emailing{" "}
          <a href="mailto:ngxiaohao123@gmail.com">ngxiaohao123@gmail.com</a>.
        </li>
      </ul>

      <h2>9. Children&rsquo;s privacy</h2>
      <p>
        The Service is not directed to individuals under 16, and we do not
        knowingly collect personal information from them. If you believe a
        minor has provided us with personal data, contact us and we will delete
        it.
      </p>

      <h2>10. International data transfers</h2>
      <p>
        Your information is processed in the Singapore / Malaysia region. By
        using the Service you consent to such transfers.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy. The &ldquo;Last updated&rdquo; date
        above reflects the most recent version. Where a change is material, we
        will make reasonable efforts to notify you.
      </p>

      <h2>12. Contact</h2>
      <p>
        For any question or request about this policy or your data, email{" "}
        <a href="mailto:ngxiaohao123@gmail.com">ngxiaohao123@gmail.com</a>.
      </p>
    </LegalPage>
  );
}
