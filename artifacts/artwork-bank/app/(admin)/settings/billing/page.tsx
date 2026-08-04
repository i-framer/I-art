import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { startSubscriptionCheckout, openBillingPortal } from "../actions";
import {
  hasActiveAccess,
  getSubscriptionBadge,
  getTrialDaysRemaining,
  SUBSCRIPTION_PRICE_CENTS,
} from "@/lib/billing";
import { formatPrice } from "@/lib/format";
import {
  Users,
  CreditCard,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { billing } = await searchParams;
  const active = hasActiveAccess(tenant);
  const status = tenant.subscriptionStatus;
  const badge = getSubscriptionBadge(status);

  // Days remaining in the Stripe trial (null unless trialing with an end date).
  const trialDaysRemaining = getTrialDaysRemaining(status, tenant.trialEnd);

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
      </div>

      {/* Flash messages */}
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

      <div className="rounded-xl border border-stone-200 bg-white p-6">
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
          {tenant.billingExempt && tenant.iframerAccountId ? (
            <span className="flex items-center gap-1 rounded-full bg-indigo-100 text-indigo-700 px-3 py-1 text-sm font-semibold">
              <Sparkles className="h-3.5 w-3.5" /> i-Framer Premium
            </span>
          ) : tenant.billingExempt ? (
            <span className="flex items-center gap-1 rounded-full bg-violet-100 text-violet-700 px-3 py-1 text-sm font-semibold">
              <Sparkles className="h-3.5 w-3.5" /> Complimentary
            </span>
          ) : badge ? (
            <div className="flex flex-col items-end gap-1.5">
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${badge.cls}`}>
                {badge.label}
              </span>
              {trialDaysRemaining !== null && (
                <span
                  className={`text-xs font-medium ${
                    trialDaysRemaining <= 3 ? "text-amber-600" : "text-stone-500"
                  }`}
                >
                  {trialDaysRemaining === 0
                    ? "Your trial ends today"
                    : `${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"} remaining in your trial`}
                </span>
              )}
              {status === "trialing" && tenant.trialEnd && (
                <span className="text-xs text-stone-400">
                  Ends{" "}
                  {new Intl.DateTimeFormat("en-AU", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }).format(tenant.trialEnd)}
                </span>
              )}
            </div>
          ) : (
            <span className="rounded-full bg-stone-100 text-stone-500 px-3 py-1 text-sm font-semibold">
              Not subscribed
            </span>
          )}
        </div>

        {tenant.billingExempt && tenant.iframerAccountId ? (
          <div className="flex items-start gap-3 text-sm text-stone-600">
            <CheckCircle2 className="h-5 w-5 text-indigo-500 shrink-0 mt-0.5" />
            <p>
              Your Artwork Bank access is included with your{" "}
              <span className="font-medium text-stone-900">i-Framer Premium</span>{" "}
              account — no separate subscription needed.
            </p>
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
                  Your subscription is no longer active. Re-subscribe to regain
                  access to your admin dashboard. Your public storefront stays
                  online either way.
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
    </div>
  );
}
