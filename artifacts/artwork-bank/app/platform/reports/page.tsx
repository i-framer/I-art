import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  inquiriesTable,
} from "@workspace/db";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin, tenantBillingStatus } from "@/lib/platform-admin";
import { ArrowLeft } from "lucide-react";
import { formatMoney, formatDate } from "../_lib/format";
import { PlatformAdminHeader } from "../_components/PlatformAdminHeader";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  exempt: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  trialing: "bg-emerald-100 text-emerald-800",
  past_due: "bg-orange-100 text-orange-800",
  canceled: "bg-red-100 text-red-700",
  none: "bg-stone-100 text-stone-500",
};

export default async function PlatformReportsPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  // 404 (not 403) so the page's existence isn't advertised to tenant admins
  if (!isPlatformAdmin(session.email)) notFound();

  const paid = sql`${ordersTable.status} in ('PAID','FULFILLED')`;

  const [tenants, orderRows, artworkRows, inquiryRows] = await Promise.all([
    db.query.tenantsTable.findMany({
      orderBy: [asc(tenantsTable.businessName)],
      columns: {
        id: true,
        businessName: true,
        slug: true,
        type: true,
        subscriptionStatus: true,
        billingExempt: true,
        trialEnd: true,
        createdAt: true,
      },
    }),
    db
      .select({
        tenantId: ordersTable.tenantId,
        paidOrders: sql<number>`count(*) filter (where ${paid})::int`,
        grossCents: sql<number>`coalesce(sum(${ordersTable.totalCents}) filter (where ${paid}), 0)::int`,
        gross30dCents: sql<number>`coalesce(sum(${ordersTable.totalCents}) filter (where ${paid} and ${ordersTable.createdAt} > now() - interval '30 days'), 0)::int`,
        refundedCents: sql<number>`coalesce(sum(${ordersTable.refundedAmountCents}), 0)::int`,
        feeCents: sql<number>`coalesce(sum(${ordersTable.applicationFeeCents}) filter (where ${paid}), 0)::int`,
        lastOrderAt: sql<string | null>`max(${ordersTable.createdAt}) filter (where ${paid})`,
      })
      .from(ordersTable)
      .groupBy(ordersTable.tenantId),
    db
      .select({
        tenantId: artworksTable.tenantId,
        total: sql<number>`count(*)::int`,
      })
      .from(artworksTable)
      .groupBy(artworksTable.tenantId),
    db
      .select({
        tenantId: inquiriesTable.tenantId,
        total: sql<number>`count(*)::int`,
        last30d: sql<number>`count(*) filter (where ${inquiriesTable.createdAt} > now() - interval '30 days')::int`,
      })
      .from(inquiriesTable)
      .groupBy(inquiriesTable.tenantId),
  ]);

  const ordersBy = new Map(orderRows.map((r) => [r.tenantId, r]));
  const artworksBy = new Map(artworkRows.map((r) => [r.tenantId, r]));
  const inquiriesBy = new Map(inquiryRows.map((r) => [r.tenantId, r]));

  const totals = {
    tenants: tenants.length,
    paying: tenants.filter(
      (t) => !t.billingExempt && t.subscriptionStatus === "active",
    ).length,
    comped: tenants.filter((t) => t.billingExempt).length,
    gross: orderRows.reduce((s, r) => s + r.grossCents, 0),
    gross30d: orderRows.reduce((s, r) => s + r.gross30dCents, 0),
    fees: orderRows.reduce((s, r) => s + r.feeCents, 0),
    refunded: orderRows.reduce((s, r) => s + r.refundedCents, 0),
    paidOrders: orderRows.reduce((s, r) => s + r.paidOrders, 0),
  };

  return (
    <div className="min-h-screen bg-stone-50">
      <PlatformAdminHeader
        title="Platform Admin — Reports"
        email={session.email ?? ""}
        activeSection="reports"
      />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Link
          href="/platform"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-4 w-4" /> Back to tenants
        </Link>

        {/* ── Platform totals ── */}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Tenants", String(totals.tenants)],
            ["Paying", String(totals.paying)],
            ["Comped", String(totals.comped)],
            ["Gross sales", formatMoney(totals.gross)],
            ["Sales (30d)", formatMoney(totals.gross30d)],
            ["Platform fees", formatMoney(totals.fees)],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs uppercase tracking-wider text-stone-500">
                {label}
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {value}
              </p>
            </div>
          ))}
        </div>

        {totals.refunded > 0 && (
          <p className="mt-2 text-xs text-stone-500">
            {formatMoney(totals.refunded)} refunded across all tenants ·{" "}
            {totals.paidOrders} paid orders all-time
          </p>
        )}

        {/* ── Per-tenant breakdown ── */}
        <div className="mt-8 overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="px-4 py-3 font-medium">Tenant</th>
                <th className="px-4 py-3 font-medium">Signed up</th>
                <th className="px-4 py-3 font-medium">Subscription</th>
                <th className="px-4 py-3 font-medium text-right">Artworks</th>
                <th className="px-4 py-3 font-medium text-right">
                  Paid orders
                </th>
                <th className="px-4 py-3 font-medium text-right">
                  Gross sales
                </th>
                <th className="px-4 py-3 font-medium text-right">
                  Sales (30d)
                </th>
                <th className="px-4 py-3 font-medium text-right">
                  Inquiries (30d)
                </th>
                <th className="px-4 py-3 font-medium">Last sale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {tenants.map((t) => {
                const o = ordersBy.get(t.id);
                const a = artworksBy.get(t.id);
                const q = inquiriesBy.get(t.id);
                const status = tenantBillingStatus(t);
                return (
                  <tr key={t.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/tenants/${t.id}`}
                        className="font-medium text-stone-900 hover:text-indigo-700 hover:underline"
                      >
                        {t.businessName}
                      </Link>
                      <p className="text-xs text-stone-500">/{t.slug}</p>
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {formatDate(t.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? STATUS_STYLES.none}`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-stone-700">
                      {a?.total ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-700">
                      {o?.paidOrders ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-800">
                      {formatMoney(o?.grossCents)}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-800">
                      {formatMoney(o?.gross30dCents)}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-700">
                      {q?.last30d ?? 0}
                      <span className="text-xs text-stone-400">
                        {" "}
                        / {q?.total ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {o?.lastOrderAt ? formatDate(o.lastOrderAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-stone-500">
          Gross sales counts PAID and FULFILLED orders. Inquiries column shows
          last 30 days / all-time.
        </p>
      </main>
    </div>
  );
}
