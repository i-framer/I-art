import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  updateTenantSettings,
  startStripeOnboarding,
  verifyCustomDomain,
  removeCustomDomain,
} from "./actions";
import {
  Users,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  CreditCard,
  Globe,
  Copy,
} from "lucide-react";
import { getStripeClient } from "@/lib/stripe";
import { getCnameTarget } from "@/lib/tenant-cache";
import { getPlatformBaseUrl } from "@/lib/base-url";
import { DomainForm } from "./_components/domain-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; stripe?: string; domain_status?: string; }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { saved, stripe, domain_status } = await searchParams;

  // Stripe Connect status
  type StripeStatus = "not_connected" | "pending" | "active";
  let stripeStatus: StripeStatus = "not_connected";
  if (tenant.stripeAccountId) {
    try {
      const stripeClient = await getStripeClient();
      const account = await stripeClient.accounts.retrieve(tenant.stripeAccountId);
      stripeStatus =
        account.details_submitted && account.charges_enabled ? "active" : "pending";
    } catch {
      stripeStatus = "pending";
    }
  }

  const platformFeePercent = process.env.PLATFORM_FEE_PERCENT ?? "5";
  const cnameTarget = getCnameTarget();

  return (
    <div className="px-8 py-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-stone-900">Settings</h1>
        <p className="text-stone-500 mt-1">
          Manage your storefront details and preferences.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-stone-200">
        <Link
          href="/settings"
          className="px-4 py-2.5 text-sm font-medium text-stone-900 border-b-2 border-stone-900 -mb-px"
        >
          General
        </Link>
        <Link
          href="/settings/team"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          <Users className="h-3.5 w-3.5" />
          Team
        </Link>
        <Link
          href="/settings/billing"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          <CreditCard className="h-3.5 w-3.5" />
          Billing
        </Link>
      </div>

      {/* ── Flash messages ─────────────────────────────────────────────────── */}
      {saved && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Settings saved successfully.
        </div>
      )}
      {stripe === "connected" && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Stripe account connected! You can now accept payments.
        </div>
      )}
      {stripe === "refresh" && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          The Stripe session expired — please reconnect to continue setup.
        </div>
      )}
      {stripe === "not_configured" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Stripe is not connected. Add the Stripe integration in the Integrations tab first.
        </div>
      )}
      {stripe === "connect_not_enabled" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Stripe rejected the request: Connect isn&apos;t enabled on the platform&apos;s
          Stripe account yet. This is a platform-side configuration issue being
          handled by the platform operator — no action is needed from your gallery.
          Please try again later.
        </div>
      )}
      {stripe === "rejected" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Stripe rejected the request, so onboarding couldn&apos;t start. Please try
          again — if it keeps failing, check the Stripe dashboard for account issues.
        </div>
      )}
      {domain_status === "saved" && (
        <div className="mb-6 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
          Domain saved. Add the CNAME record below, then click &ldquo;Verify&rdquo;.
        </div>
      )}
      {domain_status === "no_cname_target" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          The platform&apos;s CNAME target isn&apos;t configured, so domains can&apos;t be
          verified. Set the CNAME_TARGET environment variable (or a platform base URL) and try again.
        </div>
      )}
      {domain_status === "verified" && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Domain verified — your storefront is reachable at your custom domain!
        </div>
      )}
      {domain_status === "unverified" && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          Domain not yet verified. Make sure the CNAME record has been added and DNS has propagated (can take up to 48 hours).
        </div>
      )}
      {domain_status === "conflict" && (
        <div className="mb-6 rounded-lg bg-orange-50 border border-orange-200 px-4 py-3 text-sm text-orange-700">
          Domain conflict — your CNAME record points to a different host. Update it to point
          to <span className="font-mono">{cnameTarget ?? "the CNAME target shown below"}</span> and
          click &ldquo;Re-verify&rdquo;.
        </div>
      )}

      {/* ── Business details form ──────────────────────────────────────────── */}
      <form action={updateTenantSettings} className="space-y-6">
        <div className="rounded-xl border border-stone-200 bg-white p-6 space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">Business details</h2>

          <div>
            <label htmlFor="businessName" className="block text-sm font-medium text-stone-700 mb-1.5">
              Business / artist name
            </label>
            <input
              id="businessName"
              name="businessName"
              type="text"
              required
              defaultValue={tenant.businessName}
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              Default storefront URL
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-2.5">
              <span className="text-sm font-mono text-stone-600">
                {(() => {
                  const base = getPlatformBaseUrl();
                  return base
                    ? `${base.replace(/^https?:\/\//, "")}/t/${tenant.slug}`
                    : `/t/${tenant.slug}`;
                })()}
              </span>
              <ExternalLink className="h-3.5 w-3.5 text-stone-400 ml-auto" />
            </div>
            <p className="mt-1 text-xs text-stone-400">Slug cannot be changed after creation.</p>
          </div>

          <div>
            <label htmlFor="themeColor" className="block text-sm font-medium text-stone-700 mb-1.5">
              Brand colour
            </label>
            <div className="flex items-center gap-3">
              <input
                id="themeColor"
                name="themeColor"
                type="color"
                defaultValue={tenant.themeColor ?? "#1c1917"}
                className="h-10 w-16 cursor-pointer rounded-lg border border-stone-300 bg-white p-1"
              />
              <span className="text-sm text-stone-500">Used on your public storefront</span>
            </div>
          </div>
          <div>
            <label htmlFor="location" className="block text-sm font-medium text-stone-700 mb-1.5">
              Location <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <input
              id="location"
              name="location"
              type="text"
              maxLength={120}
              defaultValue={tenant.location ?? ""}
              placeholder="e.g. Fitzroy, VIC"
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
            />
            <p className="mt-1 text-xs text-stone-400">
              Shown on your public storefront and used in artwork discovery filters.
            </p>
          </div>
          <div>
            <label htmlFor="contactEmail" className="block text-sm font-medium text-stone-700 mb-1.5">
              Contact email
            </label>
            <input
              id="contactEmail"
              name="contactEmail"
              type="email"
              defaultValue={tenant.contactEmail ?? ""}
              placeholder="hello@yourgallery.com"
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
            />
            <p className="mt-1 text-xs text-stone-400">
              Buyer inquiries are sent here when online payments are unavailable.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-stone-200 bg-white p-6 space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">About page</h2>
          <div>
            <label htmlFor="aboutText" className="block text-sm font-medium text-stone-700 mb-1.5">
              About text
            </label>
            <textarea
              id="aboutText"
              name="aboutText"
              rows={5}
              defaultValue={tenant.aboutText ?? ""}
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors resize-y"
              placeholder="Tell buyers about your work, your studio, or your process…"
            />
          </div>
        </div>

        <button
          type="submit"
          className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 transition-colors"
        >
          Save changes
        </button>
      </form>

      {/* ── Custom Domain ─────────────────────────────────────────────────── */}
      <div className="mt-8 rounded-xl border border-stone-200 bg-white p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Custom domain</h2>
        </div>

        <p className="text-sm text-stone-500">
          Point your own domain (e.g.{" "}
          <span className="font-mono text-stone-700">www.yourname.com</span>) to
          your gallery. Add the CNAME record shown below in your DNS settings,
          then click Verify.
        </p>

        {/* Domain input form */}
        <DomainForm currentDomain={tenant.customDomain} />

        {/* CNAME instructions — always show so tenants know what to add */}
        {tenant.customDomain && (
          <>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 space-y-3">
              <p className="text-xs font-semibold text-stone-600 uppercase tracking-wider">
                DNS record to add
              </p>
              <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <span className="text-stone-500 font-medium">Type</span>
                <span className="font-mono text-stone-800">CNAME</span>
                <span className="text-stone-500 font-medium">Name / Host</span>
                <span className="font-mono text-stone-800">
                  {(() => {
                    const d = tenant.customDomain;
                    if (d.startsWith("www.")) return "www";
                    // Strip trailing TLD segments to find the subdomain prefix.
                    // e.g. "gallery.janeart.com" → "gallery"
                    //      "janeart.com"         → "@"  (apex domain)
                    //      "gallery.janeart.com.au" → "gallery"
                    const withoutTld = d.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/i, "");
                    const dot = withoutTld.lastIndexOf(".");
                    return dot === -1 ? "@" : withoutTld.slice(dot + 1);
                  })()}
                </span>
                <span className="text-stone-500 font-medium">Value / Target</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-stone-800">
                    {cnameTarget ?? "— not configured —"}
                  </span>
                  {cnameTarget && (
                    <Copy className="h-3.5 w-3.5 text-stone-400 shrink-0" />
                  )}
                </div>
                <span className="text-stone-500 font-medium">TTL</span>
                <span className="font-mono text-stone-800">3600</span>
              </div>
              <p className="text-xs text-stone-400">
                DNS changes can take up to 48 hours to propagate worldwide.
              </p>
            </div>

            {/* Verification status + action */}
            <div className="flex items-center justify-between gap-4">
              {tenant.customDomainVerified ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>
                    Verified — live at{" "}
                    <span className="font-mono">{tenant.customDomain}</span>
                  </span>
                </div>
              ) : domain_status === "conflict" ? (
                <div className="flex items-center gap-2 text-sm text-orange-700">
                  <AlertCircle className="h-4 w-4" />
                  <span>Conflict — CNAME points to a different host</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-amber-700">
                  <AlertCircle className="h-4 w-4" />
                  <span>Not verified yet</span>
                </div>
              )}

              <div className="flex gap-2 shrink-0">
                <form action={verifyCustomDomain}>
                  <button
                    type="submit"
                    className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
                  >
                    {tenant.customDomainVerified ? "Re-verify" : "Verify now"}
                  </button>
                </form>
                <form action={removeCustomDomain}>
                  <button
                    type="submit"
                    className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Remove
                  </button>
                </form>
              </div>
            </div>

            {/* TLS note */}
            <p className="text-xs text-stone-400 leading-relaxed">
              <strong className="text-stone-500">TLS / HTTPS:</strong> When deployed to Vercel,
              SSL certificates are provisioned automatically once your domain is verified.
              No manual steps needed.
            </p>
          </>
        )}
      </div>

      {/* ── Payments / Stripe Connect ──────────────────────────────────────── */}
      <div className="mt-8 rounded-xl border border-stone-200 bg-white p-6 space-y-4">
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Payments</h2>
        </div>
        <p className="text-sm text-stone-500">
          Connect your Stripe account to accept payments. A platform fee of{" "}
          {platformFeePercent}% applies per transaction.
        </p>

        {stripeStatus === "active" ? (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Stripe connected — payments are live.</span>
          </div>
        ) : stripeStatus === "pending" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                Stripe account setup incomplete. Complete onboarding to accept payments.
              </span>
            </div>
            <form action={startStripeOnboarding}>
              <button
                type="submit"
                className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
              >
                Continue Stripe setup →
              </button>
            </form>
          </div>
        ) : (
          <form action={startStripeOnboarding}>
            <button
              type="submit"
              className="rounded-lg bg-[#635bff] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#5a52e8] transition-colors"
            >
              Connect Stripe Account
            </button>
          </form>
        )}

        {/* Stale-cache warning — live Stripe says charges enabled but the cache disagrees */}
        {stripeStatus === "active" && tenant.stripeChargesEnabled !== true && (
          <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <div className="space-y-1">
              <p className="font-medium">Cached status is out of sync</p>
              <p className="text-amber-700">
                Stripe confirms charges are enabled on your account, but the
                cached value buyers see at checkout still shows{" "}
                {tenant.stripeChargesEnabled === false ? "disabled" : "not yet received"}.
                This usually means a webhook event was missed. To resync, go to
                your{" "}
                <a
                  href="https://dashboard.stripe.com/webhooks"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium hover:text-amber-900"
                >
                  Stripe webhook settings
                </a>{" "}
                and resend the most recent{" "}
                <span className="font-mono text-xs bg-amber-100 px-1 py-0.5 rounded">
                  account.updated
                </span>{" "}
                event, or wait for the next Stripe activity to trigger a fresh
                webhook.
              </p>
            </div>
          </div>
        )}

        {/* Cached status — shown once a Stripe account exists */}
        {tenant.stripeAccountId && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
              Checkout status (cached)
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <span className="text-stone-500">Charges enabled</span>
              {tenant.stripeChargesEnabled === true ? (
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  Yes
                </span>
              ) : tenant.stripeChargesEnabled === false ? (
                <span className="flex items-center gap-1.5 text-red-600">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  No
                </span>
              ) : (
                <span className="text-stone-400">Not yet received</span>
              )}
              <span className="text-stone-500">Payouts enabled</span>
              {tenant.stripePayoutsEnabled === true ? (
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  Yes
                </span>
              ) : tenant.stripePayoutsEnabled === false ? (
                <span className="flex items-center gap-1.5 text-red-600">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  No
                </span>
              ) : (
                <span className="text-stone-400">Not yet received</span>
              )}
            </div>
            <p className="text-xs text-stone-400 leading-relaxed pt-0.5">
              These values are updated by Stripe webhooks and are what buyers
              experience at checkout. If they look stale, complete Stripe
              onboarding and wait for the webhook to arrive.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
