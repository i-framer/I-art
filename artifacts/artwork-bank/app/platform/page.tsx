import { redirect, notFound } from "next/navigation";
import { asc, desc, isNull } from "drizzle-orm";
import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin, tenantBillingStatus } from "@/lib/platform-admin";
import { setBillingExempt } from "./actions";
import { ShieldCheck, CreditCard, CheckCircle2, AlertCircle } from "lucide-react";
import { BillingAlerts } from "./_components/BillingAlerts";
import { getStripeEnvironmentDiagnostic } from "@/lib/stripe";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  exempt: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  trialing: "bg-emerald-100 text-emerald-800",
  past_due: "bg-orange-100 text-orange-800",
  canceled: "bg-red-100 text-red-700",
  none: "bg-stone-100 text-stone-500",
};

export default async function PlatformAdminPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  // 404 (not 403) so the page's existence isn't advertised to tenant admins
  if (!isPlatformAdmin(session.email)) notFound();

  const unresolvedAlerts = await db
    .select()
    .from(stripeAlertsTable)
    .where(isNull(stripeAlertsTable.dismissedAt))
    .orderBy(desc(stripeAlertsTable.createdAt));

  const stripeEnv = await getStripeEnvironmentDiagnostic();

  const tenants = await db.query.tenantsTable.findMany({
    orderBy: [asc(tenantsTable.businessName)],
    columns: {
      id: true,
      businessName: true,
      slug: true,
      type: true,
      contactEmail: true,
      subscriptionStatus: true,
      billingExempt: true,
    },
  });

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-stone-900 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-amber-400" />
          <h1 className="text-sm font-semibold text-white">
            Platform Admin — Tenant Billing
          </h1>
          <span className="ml-auto text-xs text-stone-400">
            {session.email}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <p className="mb-6 text-sm text-stone-600">
          Comp or un-comp accounts. Exempt tenants bypass the $10/month
          subscription paywall.
        </p>

        {/* ── Stripe environment ──────────────────────────────────────────── */}
        <div className="mb-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-900">
              Stripe environment
            </h2>
            {stripeEnv.status === "ok" && (
              <span
                className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                  stripeEnv.livemode
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-800"
                }`}
              >
                {stripeEnv.livemode ? "Live mode" : "Test mode"}
              </span>
            )}
          </div>

          {stripeEnv.status === "not_configured" && (
            <p className="text-sm text-stone-600">
              Stripe isn&apos;t configured yet — no secret key was found.{" "}
              <span className="text-stone-500">{stripeEnv.message}</span>
            </p>
          )}
          {stripeEnv.status === "invalid_key" && (
            <p className="text-sm text-red-700">
              The configured Stripe key doesn&apos;t work.{" "}
              <span className="text-red-600">{stripeEnv.message}</span>
            </p>
          )}
          {stripeEnv.status === "unreachable" && (
            <p className="text-sm text-amber-700">
              Couldn&apos;t reach Stripe just now — this may be temporary and
              doesn&apos;t necessarily mean the key is wrong.{" "}
              <span className="text-amber-600">{stripeEnv.message}</span>
            </p>
          )}
          {stripeEnv.status === "ok" && (
            <div className="space-y-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                <dt className="text-stone-500">Account ID</dt>
                <dd className="font-mono text-stone-900">
                  {stripeEnv.accountId}
                </dd>
                <dt className="text-stone-500">Account name</dt>
                <dd className="text-stone-900">
                  {stripeEnv.accountName ?? (
                    <span className="text-stone-400">— not set —</span>
                  )}
                </dd>
                <dt className="text-stone-500">Connect</dt>
                <dd>
                  {stripeEnv.connectStatus === "enabled" ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Enabled
                    </span>
                  ) : stripeEnv.connectStatus === "disabled" ? (
                    <span className="inline-flex items-center gap-1.5 text-red-700">
                      <AlertCircle className="h-3.5 w-3.5" />
                      Not enabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-stone-500">
                      <AlertCircle className="h-3.5 w-3.5" />
                      Can&apos;t confirm
                    </span>
                  )}
                </dd>
              </dl>
              {stripeEnv.connectStatus === "unknown" && (
                <p className="rounded-lg bg-stone-50 border border-stone-200 px-3 py-2.5 text-xs text-stone-600 leading-relaxed">
                  Stripe didn&apos;t report Connect as disabled, but there are no
                  connected accounts yet, so it can&apos;t be confirmed as
                  enabled either. To check, open the Stripe dashboard for the
                  exact account shown above (
                  <span className="font-mono">{stripeEnv.accountId}</span>
                  {stripeEnv.livemode ? ", live mode" : ", test mode"}) and look
                  under Settings → Connect.
                </p>
              )}
              {stripeEnv.connectStatus === "disabled" && (
                <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-xs text-red-700 leading-relaxed">
                  Stripe Connect isn&apos;t enabled for this account. In the
                  Stripe dashboard, make sure you&apos;re signed into the exact
                  account/sandbox shown above (
                  <span className="font-mono">{stripeEnv.accountId}</span>
                  {stripeEnv.livemode ? ", live mode" : ", test mode"}), then
                  enable Connect there. Enabling it in a different sandbox
                  won&apos;t help — the app uses the account this key resolves
                  to.
                </p>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-stone-400">
            Shows which Stripe account the configured secret key resolves to.
            The key itself is never displayed.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="px-4 py-3 font-medium">Tenant</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Subscription</th>
                <th className="px-4 py-3 font-medium">Billing exempt</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {tenants.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-stone-500"
                  >
                    No tenants yet.
                  </td>
                </tr>
              )}
              {tenants.map((tenant) => {
                const status = tenantBillingStatus(tenant);
                return (
                  <tr key={tenant.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-stone-900">
                        {tenant.businessName}
                      </p>
                      <p className="text-xs text-stone-500">
                        /{tenant.slug}
                        {tenant.contactEmail ? ` · ${tenant.contactEmail}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-stone-600">{tenant.type}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLES[status] ?? STATUS_STYLES.none
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {tenant.billingExempt ? "Yes" : "No"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={setBillingExempt}>
                        <input
                          type="hidden"
                          name="tenantId"
                          value={tenant.id}
                        />
                        <input
                          type="hidden"
                          name="exempt"
                          value={tenant.billingExempt ? "false" : "true"}
                        />
                        <button
                          type="submit"
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                            tenant.billingExempt
                              ? "bg-stone-100 text-stone-700 hover:bg-stone-200"
                              : "bg-amber-400 text-stone-900 hover:bg-amber-300"
                          }`}
                        >
                          {tenant.billingExempt ? "Remove comp" : "Comp account"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-stone-500">
          Access is limited to emails listed in the PLATFORM_ADMIN_EMAILS
          environment variable.
        </p>

        <BillingAlerts alerts={unresolvedAlerts} />
      </main>
    </div>
  );
}
