import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  startSubscriptionCheckout,
  openBillingPortal,
  verifyIFramerAccount,
  recheckIFramerVerification,
} from "../actions";
import {
  hasActiveAccess,
  SUBSCRIPTION_PRICE_CENTS,
} from "@/lib/billing";
import { isIFramerVerifyConfigured } from "@/lib/iframer-verify";
import { formatPrice } from "@/lib/format";
import { SubscriptionStatusBadge } from "./_components/subscription-status-badge";
import {
  Users,
  CreditCard,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";

export const metadata: Metadata = { title: "Billing" };

const IFRAMER_SIGNUP_URL =
  process.env.IFRAMER_SIGNUP_URL ?? "https://iframer.com.au/pricing";

// Map of iframer= search-param values to user-facing messages
const IFRAMER_MESSAGES: Record<string, { type: "success" | "error" | "info"; text: string }> = {
  verified: {
    type: "success",
    text: "i-Framer Premium verified — your Artwork Bank access is now free and sales commission is reduced to 3.5%.",
  },
  not_premium: {
    type: "error",
    text: "Your i-Framer account is not on the Premium plan. Artwork Bank is free on the Premium plan only.",
  },
  already_linked: {
    type: "error",
    text: "This i-Framer account is already linked to another gallery. Each i-Framer account can be linked to one gallery.",
  },
  invalid_url: {
    type: "error",
    text: "The URL you entered doesn't look like a valid i-Framer portal URL. Please paste the URL from your i-Framer dashboard.",
  },
  not_configured: {
    type: "info",
    text: "i-Framer verification is not yet configured on this platform. Contact the operator to enable it.",
  },
  rate_limited: {
    type: "error",
    text: "Too many verification attempts. Please wait an hour before trying again.",
  },
  db_error: {
    type: "error",
    text: "Verification failed due to a temporary error. Please try again in a moment.",
  },
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string; iframer?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { billing, iframer: iframerParam } = await searchParams;
  const active = hasActiveAccess(tenant);
  const status = tenant.subscriptionStatus;

  // Silently re-check i-Framer verification if the last check is stale
  if (tenant.billingExempt && tenant.iframerAccountId && tenant.iframerVerifiedAt) {
    // Fire-and-forget — we don't await so the page doesn't block
    recheckIFramerVerification(
      tenant.id,
      tenant.iframerAccountId,
      tenant.iframerVerifiedAt,
    ).catch(() => {});
  }

  const iframerVerifyEnabled = isIFramerVerifyConfigured();
  const iframerMsg = iframerParam ? IFRAMER_MESSAGES[iframerParam] : null;

  const isIFramerVerified = tenant.billingExempt && tenant.iframerVerifiedAt;

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
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
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
          className="px-4 py-2.5 text-sm font-medium text-stone-900 border-b-2 border-stone-900 -mb-px flex items-center gap-1.5"
        >
          <CreditCard className="h-3.5 w-3.5" />
          Billing
        </Link>
        <Link
          href="/settings/freight"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          Freight
        </Link>
      </div>

      {/* Billing flash messages */}
      {billing === "subscribed" && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Subscription started — welcome aboard! It can take a few seconds for
          the status below to update.
        </div>
      )}
      {billing === "cancelled" && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          Checkout was cancelled — no charge was made.
        </div>
      )}
      {billing === "not_configured" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Billing is temporarily unavailable. Please try again later.
        </div>
      )}
      {billing === "stripe_error" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Stripe rejected the request, so the billing action couldn&apos;t complete.
          Please try again in a moment — the details have been logged.
        </div>
      )}
      {billing === "customer_reset" && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          Your saved Stripe billing profile no longer exists, so it has been
          reset. Please start a new subscription below.
        </div>
      )}

      {/* i-Framer verification flash messages */}
      {iframerMsg && (
        <div className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
          iframerMsg.type === "success"
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : iframerMsg.type === "error"
            ? "bg-red-50 border-red-200 text-red-700"
            : "bg-blue-50 border-blue-200 text-blue-700"
        }`}>
          {iframerMsg.text}
          {iframerParam === "not_premium" && (
            <a
              href={IFRAMER_SIGNUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 underline font-medium"
            >
              Upgrade at iframer.com.au →
            </a>
          )}
        </div>
      )}

      {/* ── Subscription card ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-stone-200 bg-white p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">
              Artwork Bank subscription
            </h2>
            <p className="text-sm text-stone-500 mt-1">
              {formatPrice(SUBSCRIPTION_PRICE_CENTS)}/month — full access to
              your catalog, storefront, orders and inquiries.
            </p>
          </div>
          <SubscriptionStatusBadge
            subscriptionStatus={status}
            billingExempt={tenant.billingExempt}
            iframerAccountId={tenant.iframerAccountId}
            trialEnd={tenant.trialEnd}
          />
        </div>

        {isIFramerVerified && tenant.iframerAccountId ? (
          <div className="space-y-2">
            <div className="flex items-start gap-3 text-sm text-stone-600">
              <CheckCircle2 className="h-5 w-5 text-indigo-500 shrink-0 mt-0.5" />
              <div>
                <p>
                  Your Artwork Bank access is included with your{" "}
                  <span className="font-medium text-stone-900">i-Framer Premium</span>{" "}
                  account — no separate subscription needed.
                </p>
                <p className="text-xs text-stone-400 mt-0.5">
                  Sales commission: <strong className="text-stone-600">3.5%</strong>
                  {" · "}Account: <code className="bg-stone-100 px-1 rounded text-stone-600">{tenant.iframerAccountId}</code>
                  {tenant.iframerVerifiedAt && (
                    <> · Verified {new Date(tenant.iframerVerifiedAt).toLocaleDateString("en-AU")}</>
                  )}
                </p>
              </div>
            </div>
          </div>
        ) : tenant.billingExempt ? (
          <div className="flex items-start gap-3 text-sm text-stone-600">
            <CheckCircle2 className="h-5 w-5 text-violet-500 shrink-0 mt-0.5" />
            <p>
              Your account has complimentary access — no subscription needed.
            </p>
          </div>
        ) : active ? (
          <div className="space-y-4">
            {status === "past_due" && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <p>
                  Your last payment failed. Please update your payment method —
                  access will be suspended if the payment can&apos;t be
                  collected.
                </p>
              </div>
            )}
            <form action={openBillingPortal}>
              <button
                type="submit"
                className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
              >
                Manage subscription
              </button>
            </form>
            <p className="text-xs text-stone-400">
              Update your card, view invoices, or cancel — handled securely by
              Stripe.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {status && (
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <p>
                  {status === "incomplete_expired"
                    ? "Your subscription setup wasn't completed — the checkout window expired before payment was collected. Subscribe below to get started."
                    : "Your subscription is no longer active. Re-subscribe to regain access to your admin dashboard. Your public storefront stays online either way."}
                </p>
              </div>
            )}
            <form action={startSubscriptionCheckout}>
              <button
                type="submit"
                className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
              >
                Subscribe — {formatPrice(SUBSCRIPTION_PRICE_CENTS)}/month
              </button>
            </form>
            {tenant.stripeCustomerId && (
              <form action={openBillingPortal}>
                <button
                  type="submit"
                  className="text-xs text-stone-500 underline underline-offset-2 hover:text-stone-700"
                >
                  View past invoices
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      {/* ── i-Framer Premium section ───────────────────────────────────────── */}
      {!isIFramerVerified && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="rounded-lg bg-indigo-100 p-1.5">
              {/* simple i-Framer icon placeholder */}
              <svg className="h-4 w-4 text-indigo-600" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="18" height="18" rx="3" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-stone-900">
                Existing i-Framer customer?
              </h2>
              <p className="text-sm text-stone-600 mt-0.5">
                Artwork Bank is <strong>free</strong> on the i-Framer Premium plan.
                Sales commission is reduced from 5% to <strong>3.5%</strong>.
              </p>
            </div>
          </div>

          {isIFramerVerified ? null : iframerVerifyEnabled ? (
            <form action={verifyIFramerAccount} className="space-y-3">
              <div>
                <label htmlFor="iframerPortalUrl" className="block text-xs font-medium text-stone-700 mb-1">
                  Your i-Framer portal URL
                </label>
                <div className="flex gap-2">
                  <input
                    id="iframerPortalUrl"
                    name="iframerPortalUrl"
                    type="url"
                    required
                    defaultValue={tenant.iframerPortalUrl ?? ""}
                    placeholder="https://portal.iframer.com.au/accounts/your-gallery"
                    className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                  />
                  <button
                    type="submit"
                    className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800 transition-colors"
                  >
                    Verify
                  </button>
                </div>
                <p className="text-xs text-stone-400 mt-1">
                  Paste the URL from your i-Framer portal dashboard. Only active Premium subscriptions qualify.
                </p>
              </div>
            </form>
          ) : (
            <p className="text-sm text-stone-500 italic">
              Verification is not yet configured on this platform. Contact the operator to enable it.
            </p>
          )}

          <div className="mt-4 pt-4 border-t border-indigo-200">
            <p className="text-xs text-stone-500">
              Not an i-Framer customer?{" "}
              <a
                href={IFRAMER_SIGNUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
              >
                Sign up at iframer.com.au
                <ExternalLink className="h-3 w-3" />
              </a>
              {" "}to get Artwork Bank free and enjoy framing-job integration.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
