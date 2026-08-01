import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Artwork Bank",
  description:
    "Privacy Policy for Artwork Bank (i-art.com.au) — how we collect, use, and protect your personal information.",
};

const LAST_UPDATED = "1 August 2026";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Link
          href="/"
          className="text-sm text-stone-400 hover:text-stone-600 transition-colors"
        >
          ← Back
        </Link>
        <h1 className="mt-6 text-3xl font-semibold text-stone-900">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-stone-400">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-4 leading-relaxed text-stone-600 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-stone-900 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_strong]:font-medium [&_strong]:text-stone-800">
          <h2>1. Who we are</h2>
          <p>
            Artwork Bank (i-art.com.au and its subdomains, the
            &ldquo;Platform&rdquo;) is operated by I-FRAMER Pty Ltd. This
            policy explains how we handle personal information in accordance
            with the Privacy Act 1988 (Cth) and the Australian Privacy
            Principles.
          </p>

          <h2>2. What we collect</h2>
          <ul>
            <li>
              <strong>Account information</strong> — name, email address,
              password (stored as a secure hash), and business details for
              Sellers.
            </li>
            <li>
              <strong>Order information</strong> — buyer name, email, shipping
              address, and details of the artworks purchased.
            </li>
            <li>
              <strong>Payment information</strong> — handled by Stripe. We do
              not store credit card numbers; we receive only transaction
              identifiers and payment status from Stripe.
            </li>
            <li>
              <strong>Technical information</strong> — IP address, browser
              type, and usage data collected through cookies and server logs
              for security and performance.
            </li>
          </ul>

          <h2>3. How we use it</h2>
          <ul>
            <li>Operating the marketplace — accounts, listings, and orders</li>
            <li>
              Processing payments and paying out Sellers through Stripe
            </li>
            <li>
              Sending transactional emails — order confirmations, shipping
              updates, and account notices
            </li>
            <li>Preventing fraud and securing the Platform</li>
            <li>Complying with legal obligations</li>
          </ul>
          <p>
            We do not sell personal information, and we do not use it for
            third-party advertising.
          </p>

          <h2>4. Sharing</h2>
          <p>We share personal information only with:</p>
          <ul>
            <li>
              <strong>Sellers</strong> — when you buy an artwork, the Seller
              receives your name, contact details, and shipping address so they
              can fulfil your order.
            </li>
            <li>
              <strong>Service providers</strong> — Stripe (payments), our
              hosting and database providers, and our email delivery provider.
              Some providers may store data outside Australia (for example, in
              the United States); we take reasonable steps to ensure they
              handle it consistently with Australian privacy law.
            </li>
            <li>
              <strong>Authorities</strong> — where required by law.
            </li>
          </ul>

          <h2>5. Cookies</h2>
          <p>
            We use a session cookie to keep you signed in. It is essential to
            the operation of the Platform. We do not use third-party
            advertising or tracking cookies.
          </p>

          <h2>6. Security</h2>
          <p>
            Personal information is stored in encrypted databases hosted in
            Australia where practicable, transmitted over HTTPS, and accessible
            only to authorised personnel. Payment card details never touch our
            servers — they are handled entirely by Stripe.
          </p>

          <h2>7. Retention</h2>
          <p>
            We keep account and order records for as long as needed to operate
            the Platform and meet legal obligations (such as tax record
            keeping), then delete or de-identify them.
          </p>

          <h2>8. Access and correction</h2>
          <p>
            You can access and update most of your information from your
            account settings. You may also contact us to request access to,
            correction of, or deletion of your personal information. We will
            respond within a reasonable time.
          </p>

          <h2>9. Complaints</h2>
          <p>
            If you believe we have mishandled your personal information,
            contact us first and we will investigate. If you are not satisfied
            with our response, you can complain to the Office of the Australian
            Information Commissioner (oaic.gov.au).
          </p>

          <h2>10. Changes</h2>
          <p>
            We may update this policy from time to time. The latest version
            will always be available on this page with its effective date.
          </p>
        </div>
      </div>
    </div>
  );
}
