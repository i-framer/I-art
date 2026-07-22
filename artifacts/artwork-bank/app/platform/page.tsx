import { redirect, notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin, tenantBillingStatus } from "@/lib/platform-admin";
import { setBillingExempt } from "./actions";
import { ShieldCheck } from "lucide-react";

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
      </main>
    </div>
  );
}
