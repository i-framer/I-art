import { redirect } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";
import { eq } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import { getSession } from "@/lib/auth";
import { hasActiveAccess } from "@/lib/billing";

/**
 * Subscription paywall for the gated admin sections (dashboard, catalog,
 * orders, inquiries). Settings lives outside this route group so tenants can
 * always reach the billing page to subscribe. Public storefronts are never
 * gated.
 */
export default async function GatedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  if (!hasActiveAccess(tenant)) {
    return (
      <div className="flex min-h-screen items-center justify-center px-8">
        <div className="max-w-md w-full rounded-xl border border-stone-200 bg-white p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <Lock className="h-6 w-6 text-amber-600" />
          </div>
          <h1 className="text-lg font-semibold text-stone-900">
            Subscription required
          </h1>
          <p className="text-sm text-stone-500 mt-2 leading-relaxed">
            {tenant.subscriptionStatus
              ? "Your subscription is no longer active. Re-subscribe to regain access to your dashboard, catalog, orders and inquiries."
              : "Subscribe to Artwork Bank to access your dashboard, catalog, orders and inquiries."}{" "}
            Your public storefront stays online.
          </p>
          <Link
            href="/settings/billing"
            className="mt-6 inline-block rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Go to Billing
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
