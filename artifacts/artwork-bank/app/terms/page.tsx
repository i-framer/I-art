import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Artwork Bank",
  description:
    "Terms of Service for Artwork Bank (i-art.com.au) — the online marketplace for galleries, framers, and artists.",
};

const LAST_UPDATED = "1 August 2026";

export default function TermsPage() {
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
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-stone-400">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-4 leading-relaxed text-stone-600 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-stone-900 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_strong]:font-medium [&_strong]:text-stone-800">
          <h2>1. About these terms</h2>
          <p>
            Artwork Bank (accessible at i-art.com.au and its subdomains, the
            &ldquo;Platform&rdquo;) is an online marketplace operated by
            I-FRAMER Pty Ltd (&ldquo;we&rdquo;, &ldquo;us&rdquo;,
            &ldquo;our&rdquo;) that allows galleries, framers, and artists
            (&ldquo;Sellers&rdquo;) to list and sell original artwork to buyers
            (&ldquo;Buyers&rdquo;). By using the Platform you agree to these
            Terms of Service. If you do not agree, do not use the Platform.
          </p>

          <h2>2. The marketplace</h2>
          <p>
            Artwork Bank is a venue. Each artwork listed on the Platform is
            offered and sold by the Seller identified on the listing — not by
            us. The contract of sale for any artwork is between the Buyer and
            the Seller. We are not a party to that contract and do not take
            ownership of any artwork at any time.
          </p>

          <h2>3. Accounts</h2>
          <ul>
            <li>
              You must provide accurate information when registering and keep
              your login credentials secure. You are responsible for all
              activity that occurs under your account.
            </li>
            <li>
              Seller accounts may invite staff members; the account owner is
              responsible for the actions of invited staff.
            </li>
            <li>
              We may suspend or terminate accounts that breach these terms,
              provide false information, or use the Platform unlawfully.
            </li>
          </ul>

          <h2>4. Payments</h2>
          <ul>
            <li>
              Payments are processed by Stripe. By purchasing or selling on the
              Platform you also agree to Stripe&rsquo;s applicable terms,
              including the Stripe Connected Account Agreement for Sellers.
            </li>
            <li>
              All prices are listed in Australian dollars (AUD) unless stated
              otherwise.
            </li>
            <li>
              We charge Sellers a platform commission on each sale, deducted
              automatically at the time of payment. The current commission rate
              is shown to Sellers during onboarding and in their settings.
            </li>
            <li>
              Sellers may also pay a recurring subscription fee for use of the
              Platform, billed via Stripe.
            </li>
          </ul>

          <h2>5. Seller obligations</h2>
          <ul>
            <li>
              Sellers must have the legal right to sell every artwork they
              list, and listings must be accurate — including price,
              description, condition, and images.
            </li>
            <li>
              Sellers are responsible for fulfilling orders, including packing,
              shipping, insurance in transit, and complying with Australian
              Consumer Law obligations to Buyers.
            </li>
            <li>
              Sellers are responsible for their own tax obligations, including
              GST where applicable.
            </li>
          </ul>

          <h2>6. Buyers, refunds and returns</h2>
          <ul>
            <li>
              Because each sale is a contract between the Buyer and the Seller,
              refund and return requests are handled by the Seller in the
              first instance.
            </li>
            <li>
              Nothing in these terms limits any rights a Buyer has under the
              Australian Consumer Law, including consumer guarantees that
              cannot be excluded.
            </li>
            <li>
              Where a refund is issued through the Platform, it is processed
              back to the original payment method via Stripe.
            </li>
          </ul>

          <h2>7. Content and intellectual property</h2>
          <ul>
            <li>
              Sellers retain all rights in the artwork and images they upload,
              and grant us a non-exclusive licence to display that content on
              the Platform for the purpose of operating the marketplace.
            </li>
            <li>
              You must not upload content that infringes another person&rsquo;s
              rights, is unlawful, or is misleading.
            </li>
            <li>
              The Platform itself — including its software, design, and
              branding — is owned by us or our licensors.
            </li>
          </ul>

          <h2>8. Custom domains and subdomains</h2>
          <p>
            Sellers receive a storefront on a Platform subdomain and may
            connect their own custom domain. Sellers are responsible for their
            domain registrations and DNS configuration. We may reclaim
            subdomains that are inactive, misleading, or breach these terms.
          </p>

          <h2>9. Acceptable use</h2>
          <p>
            You must not misuse the Platform — including attempting to gain
            unauthorised access, interfering with its operation, scraping data
            at scale, or using it to send spam or engage in fraudulent
            transactions.
          </p>

          <h2>10. Liability</h2>
          <p>
            To the maximum extent permitted by law, we exclude all implied
            conditions and warranties, and our total liability arising out of
            or in connection with the Platform is limited to the commissions we
            received on the transaction giving rise to the claim. Nothing in
            these terms excludes rights that cannot be excluded under the
            Australian Consumer Law.
          </p>

          <h2>11. Changes</h2>
          <p>
            We may update these terms from time to time. Material changes will
            be notified on the Platform or by email. Continued use after a
            change takes effect constitutes acceptance of the updated terms.
          </p>

          <h2>12. Governing law</h2>
          <p>
            These terms are governed by the laws of New South Wales, Australia,
            and you submit to the non-exclusive jurisdiction of the courts of
            that state.
          </p>

          <h2>13. Contact</h2>
          <p>
            Questions about these terms can be sent to us via the contact
            details published on the Platform.
          </p>
        </div>
      </div>
    </div>
  );
}
