import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { ordersTable, orderItemsTable } from "@workspace/db";
import { and, eq, desc, count } from "drizzle-orm";
import { formatPrice } from "@/lib/tenant-cache";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
import { AlertTriangle } from "lucide-react";

export const metadata: Metadata = { title: "Orders" };

const PAGE_SIZE = 25;

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "bg-amber-100 text-amber-700" },
  PAID: { label: "Paid", cls: "bg-blue-100 text-blue-700" },
  FULFILLED: { label: "Fulfilled", cls: "bg-emerald-100 text-emerald-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-red-100 text-red-700" },
};

const FULFILLMENT_LABELS: Record<string, string> = {
  SHIP: "Ship",
  PICKUP: "Pickup",
  FRAMING_JOB: "Framing",
};

type SearchParams = { status?: string; page?: string };

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const statusFilter = sp.status && sp.status !== "ALL" ? sp.status : null;

  const conditions = [eq(ordersTable.tenantId, session.tenantId)];
  if (statusFilter) {
    conditions.push(eq(ordersTable.status, statusFilter as any));
  }
  const where = and(...conditions);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        order: ordersTable,
        artworkTitle: orderItemsTable.artworkTitle,
      })
      .from(ordersTable)
      .leftJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
      .where(where)
      .orderBy(desc(ordersTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(ordersTable).where(where),
  ]);

  const total = countRow?.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const STATUS_TABS = ["ALL", "PAID", "FULFILLED", "CANCELLED", "PENDING"];

  function buildUrl(params: Record<string, string | undefined>) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `/orders?${qs}` : "/orders";
  }

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Orders</h1>
        <p className="text-stone-500 mt-1 text-sm">
          {total} {total === 1 ? "order" : "orders"}
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-6 border-b border-stone-200">
        {STATUS_TABS.map((s) => {
          const isActive = (sp.status ?? "ALL") === s;
          return (
            <Link
              key={s}
              href={buildUrl({ status: s === "ALL" ? undefined : s, page: "1" })}
              className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                isActive
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700"
              }`}
            >
              {s === "ALL" ? "All" : (STATUS_STYLES[s]?.label ?? s)}
            </Link>
          );
        })}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-stone-400">
          <p className="text-lg">No orders yet</p>
          <p className="text-sm mt-1">Orders will appear here after a buyer completes checkout.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-5 py-3 font-medium text-stone-500">Date</th>
                <th className="text-left px-5 py-3 font-medium text-stone-500">Buyer</th>
                <th className="text-left px-5 py-3 font-medium text-stone-500">Artwork</th>
                <th className="text-left px-5 py-3 font-medium text-stone-500">Fulfilment</th>
                <th className="text-right px-5 py-3 font-medium text-stone-500">Amount</th>
                <th className="text-left px-5 py-3 font-medium text-stone-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map(({ order, artworkTitle }) => {
                const badge = STATUS_STYLES[order.status];
                const emailFailed =
                  !order.emailSentAt &&
                  order.emailAttempts >= MAX_EMAIL_ATTEMPTS;
                return (
                  <tr
                    key={order.id}
                    className="hover:bg-stone-50 transition-colors"
                  >
                    <td className="px-5 py-3.5 text-stone-500 whitespace-nowrap">
                      <Link href={`/orders/${order.id}`} className="hover:text-stone-900 transition-colors">
                        {order.createdAt.toLocaleDateString("en-AU", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <Link href={`/orders/${order.id}`} className="group">
                        <p className="font-medium text-stone-900 group-hover:underline underline-offset-2">
                          {order.buyerName ?? "—"}
                        </p>
                        <p className="text-stone-400 text-xs">{order.buyerEmail}</p>
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 text-stone-700 max-w-[220px] truncate">
                      {artworkTitle ?? "—"}
                    </td>
                    <td className="px-5 py-3.5 text-stone-500">
                      {FULFILLMENT_LABELS[order.fulfillmentType] ?? order.fulfillmentType}
                    </td>
                    <td className="px-5 py-3.5 text-right font-medium text-stone-900 whitespace-nowrap">
                      {formatPrice(order.totalCents)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        {badge && (
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>
                            {badge.label}
                          </span>
                        )}
                        {emailFailed && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700"
                            title="Buyer confirmation email failed after all retry attempts"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Email failed
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          {page > 1 && (
            <Link
              href={buildUrl({ status: sp.status, page: String(page - 1) })}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              ← Previous
            </Link>
          )}
          <span className="text-sm text-stone-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={buildUrl({ status: sp.status, page: String(page + 1) })}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
