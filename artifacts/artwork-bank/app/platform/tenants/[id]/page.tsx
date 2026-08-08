import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  tenantsTable,
  tenantUsersTable,
  usersTable,
  artworksTable,
  ordersTable,
  inquiriesTable,
} from "@workspace/db";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin, tenantBillingStatus } from "@/lib/platform-admin";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import {
  formatMoney,
  formatDate,
  formatDateTime,
  subscriptionDetail,
} from "../../_lib/format";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  exempt: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  trialing: "bg-emerald-100 text-emerald-800",
  past_due: "bg-orange-100 text-orange-800",
  canceled: "bg-red-100 text-red-700",
  none: "bg-stone-100 text-stone-500",
};

const ORDER_STATUS_STYLES: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-800",
  FULFILLED: "bg-indigo-100 text-indigo-800",
  PENDING: "bg-stone-100 text-stone-600",
  CANCELLED: "bg-red-100 text-red-700",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
      {children}
    </div>
  );
}

export default async function PlatformTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  // 404 (not 403) so the page's existence isn't advertised to tenant admins
  if (!isPlatformAdmin(session.email)) notFound();

  const { id } = await params;

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, id),
  });
  if (!tenant) notFound();

  const [users, artworkCounts, orderStats, recentOrders, inquiryStats] =
    await Promise.all([
      db
        .select({
          email: usersTable.email,
          role: tenantUsersTable.role,
          userCreatedAt: usersTable.createdAt,
        })
        .from(tenantUsersTable)
        .innerJoin(usersTable, eq(tenantUsersTable.userId, usersTable.id))
        .where(eq(tenantUsersTable.tenantId, tenant.id)),
      db
        .select({
          status: artworksTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(artworksTable)
        .where(eq(artworksTable.tenantId, tenant.id))
        .groupBy(artworksTable.status),
      db
        .select({
          paidOrders: sql<number>`count(*) filter (where ${ordersTable.status} in ('PAID','FULFILLED'))::int`,
          totalOrders: sql<number>`count(*)::int`,
          grossCents: sql<number>`coalesce(sum(${ordersTable.totalCents}) filter (where ${ordersTable.status} in ('PAID','FULFILLED')), 0)::int`,
          refundedCents: sql<number>`coalesce(sum(${ordersTable.refundedAmountCents}), 0)::int`,
          feeCents: sql<number>`coalesce(sum(${ordersTable.applicationFeeCents}) filter (where ${ordersTable.status} in ('PAID','FULFILLED')), 0)::int`,
          lastOrderAt: sql<string | null>`max(${ordersTable.createdAt}) filter (where ${ordersTable.status} in ('PAID','FULFILLED'))`,
        })
        .from(ordersTable)
        .where(eq(ordersTable.tenantId, tenant.id)),
      db.query.ordersTable.findMany({
        where: eq(ordersTable.tenantId, tenant.id),
        orderBy: [desc(ordersTable.createdAt)],
        limit: 10,
        columns: {
          id: true,
          buyerEmail: true,
          buyerName: true,
          status: true,
          totalCents: true,
          refundedAmountCents: true,
          createdAt: true,
        },
      }),
      db
        .select({
          total: sql<number>`count(*)::int`,
          open: sql<number>`count(*) filter (where ${inquiriesTable.status} = 'NEW' and ${inquiriesTable.archivedAt} is null)::int`,
          last30d: sql<number>`count(*) filter (where ${inquiriesTable.createdAt} > now() - interval '30 days')::int`,
        })
        .from(inquiriesTable)
        .where(eq(inquiriesTable.tenantId, tenant.id)),
    ]);

  const stats = orderStats[0];
  const inquiries = inquiryStats[0];
  const status = tenantBillingStatus(tenant);
  const artworkTotal = artworkCounts.reduce((s, r) => s + r.count, 0);
  const countFor = (s: string) =>
    artworkCounts.find((r) => r.status === s)?.count ?? 0;

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-stone-900 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-amber-400" />
          <h1 className="text-sm font-semibold text-white">
            Platform Admin — {tenant.businessName}
          </h1>
          <span className="ml-auto text-xs text-stone-400">
            {session.email}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Link
          href="/platform"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-4 w-4" /> All tenants
        </Link>

        {/* ── Overview cards ── */}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            {
              label: "Signed up",
              value: formatDate(tenant.createdAt),
            },
            {
              label: "Gross sales",
              value: formatMoney(stats.grossCents),
              sub:
                stats.refundedCents > 0
                  ? `${formatMoney(stats.refundedCents)} refunded`
                  : undefined,
            },
            {
              label: "Paid orders",
              value: String(stats.paidOrders),
              sub: stats.lastOrderAt
                ? `last ${formatDate(stats.lastOrderAt)}`
                : "no sales yet",
            },
            {
              label: "Artworks",
              value: String(artworkTotal),
              sub: `${countFor("AVAILABLE")} available · ${countFor("SOLD")} sold`,
            },
          ].map((c) => (
            <div
              key={c.label}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs uppercase tracking-wider text-stone-500">
                {c.label}
              </p>
              <p className="mt-1 text-lg font-semibold text-stone-900">
                {c.value}
              </p>
              {c.sub && <p className="text-xs text-stone-500">{c.sub}</p>}
            </div>
          ))}
        </div>

        {/* ── Account & subscription ── */}
        <Section title="Account & subscription">
          <Card>
            <dl className="divide-y divide-stone-100 text-sm">
              {[
                ["Business name", tenant.businessName],
                ["Storefront", `${tenant.slug}.i-art.com.au`],
                [
                  "Custom domain",
                  tenant.customDomain
                    ? `${tenant.customDomain}${tenant.customDomainVerified ? " (verified)" : " (unverified)"}`
                    : "—",
                ],
                ["Type", tenant.type],
                ["Contact email", tenant.contactEmail ?? "—"],
                [
                  "Subscription",
                  <span key="s" className="inline-flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? STATUS_STYLES.none}`}
                    >
                      {status}
                    </span>
                    <span className="text-stone-600">
                      {subscriptionDetail(tenant)}
                    </span>
                  </span>,
                ],
                ["Trial ends", formatDate(tenant.trialEnd)],
                [
                  "Stripe customer",
                  tenant.stripeCustomerId ? (
                    <span key="c" className="font-mono text-xs">
                      {tenant.stripeCustomerId}
                    </span>
                  ) : (
                    "—"
                  ),
                ],
                [
                  "Stripe Connect",
                  tenant.stripeAccountId
                    ? `${tenant.stripeAccountId} · charges ${tenant.stripeChargesEnabled ? "on" : "off"} · payouts ${tenant.stripePayoutsEnabled ? "on" : "off"}`
                    : "Not connected",
                ],
                [
                  "i-Framer Premium",
                  tenant.iframerAccountId
                    ? `Linked (${tenant.iframerAccountId})`
                    : "Not linked",
                ],
                ["Created", formatDateTime(tenant.createdAt)],
                ["Last updated", formatDateTime(tenant.updatedAt)],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="flex items-start gap-4 px-4 py-2.5"
                >
                  <dt className="w-40 shrink-0 text-stone-500">{label}</dt>
                  <dd className="text-stone-800">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </Section>

        {/* ── Users ── */}
        <Section title={`Users (${users.length})`}>
          <Card>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Account created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {users.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-6 text-center text-stone-500"
                    >
                      No users linked to this tenant.
                    </td>
                  </tr>
                )}
                {users.map((u) => (
                  <tr key={u.email}>
                    <td className="px-4 py-3 text-stone-900">{u.email}</td>
                    <td className="px-4 py-3 text-stone-600 capitalize">
                      {u.role}
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {formatDate(u.userCreatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>

        {/* ── Recent orders ── */}
        <Section title="Recent orders">
          <Card>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Buyer</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recentOrders.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center text-stone-500"
                    >
                      No orders yet.
                    </td>
                  </tr>
                )}
                {recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-3">
                      <p className="text-stone-900">{o.buyerName ?? "—"}</p>
                      <p className="text-xs text-stone-500">{o.buyerEmail}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_STYLES[o.status] ?? "bg-stone-100 text-stone-600"}`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-stone-800">
                      {formatMoney(o.totalCents)}
                      {(o.refundedAmountCents ?? 0) > 0 && (
                        <p className="text-xs text-red-600">
                          −{formatMoney(o.refundedAmountCents)} refunded
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {formatDate(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>

        {/* ── Inquiries ── */}
        <Section title="Inquiries">
          <Card>
            <div className="grid grid-cols-3 divide-x divide-stone-100 text-center">
              {[
                ["Total", inquiries.total],
                ["Open (unhandled)", inquiries.open],
                ["Last 30 days", inquiries.last30d],
              ].map(([label, value]) => (
                <div key={String(label)} className="px-4 py-4">
                  <p className="text-lg font-semibold text-stone-900">
                    {value}
                  </p>
                  <p className="text-xs uppercase tracking-wider text-stone-500">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </Section>
      </main>
    </div>
  );
}
