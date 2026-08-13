/**
 * Consignment payments dashboard  (Task #82)
 *
 * Shows: outstanding artist balances, agreements expiring within 30 days,
 * and a form to record an artist payment.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  consignmentAgreementsTable,
  consignmentSalesTable,
  consignmentItemsTable,
  artistPaymentsTable,
  representedArtistsTable,
} from "@workspace/db";
import { eq, and, sum, sql, asc } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import { recordArtistPayment } from "../actions";

export const metadata: Metadata = { title: "Payments Dashboard" };

export default async function PaymentsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { saved, error } = await searchParams;

  const today = new Date();
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]!;
  const todayStr = today.toISOString().split("T")[0]!;

  const [artists, salesByArtist, paymentsByArtist, expiringAgreements] =
    await Promise.all([
      db
        .select({ id: representedArtistsTable.id, name: representedArtistsTable.name })
        .from(representedArtistsTable)
        .where(eq(representedArtistsTable.tenantId, session.tenantId))
        .orderBy(asc(representedArtistsTable.name)),

      // Total artist amounts from all sales, by artist
      db
        .select({
          artistId: consignmentAgreementsTable.artistId,
          totalOwed: sum(consignmentSalesTable.artistAmountCents),
        })
        .from(consignmentSalesTable)
        .innerJoin(
          consignmentItemsTable,
          eq(consignmentSalesTable.itemId, consignmentItemsTable.id),
        )
        .innerJoin(
          consignmentAgreementsTable,
          eq(consignmentItemsTable.agreementId, consignmentAgreementsTable.id),
        )
        .where(
          and(
            eq(consignmentAgreementsTable.tenantId, session.tenantId),
            eq(consignmentSalesTable.paymentStatus, "PENDING"),
          ),
        )
        .groupBy(consignmentAgreementsTable.artistId),

      // Total payments made, by artist
      db
        .select({
          artistId: artistPaymentsTable.artistId,
          totalPaid: sum(artistPaymentsTable.amountCents),
        })
        .from(artistPaymentsTable)
        .where(eq(artistPaymentsTable.tenantId, session.tenantId))
        .groupBy(artistPaymentsTable.artistId),

      // Agreements expiring within 30 days
      db
        .select({
          id: consignmentAgreementsTable.id,
          endDate: consignmentAgreementsTable.endDate,
          artistName: representedArtistsTable.name,
        })
        .from(consignmentAgreementsTable)
        .innerJoin(
          representedArtistsTable,
          eq(consignmentAgreementsTable.artistId, representedArtistsTable.id),
        )
        .where(
          and(
            eq(consignmentAgreementsTable.tenantId, session.tenantId),
            eq(consignmentAgreementsTable.status, "ACTIVE"),
            sql`${consignmentAgreementsTable.endDate} IS NOT NULL
                AND ${consignmentAgreementsTable.endDate} >= ${todayStr}
                AND ${consignmentAgreementsTable.endDate} <= ${in30Days}`,
          ),
        ),
    ]);

  // Build outstanding-balance map
  const owedMap: Record<string, number> = {};
  salesByArtist.forEach((r) => {
    owedMap[r.artistId] = Number(r.totalOwed ?? 0);
  });
  const paidMap: Record<string, number> = {};
  paymentsByArtist.forEach((r) => {
    paidMap[r.artistId] = Number(r.totalPaid ?? 0);
  });

  const artistsWithBalance = artists
    .map((a) => ({
      ...a,
      owedCents: owedMap[a.id] ?? 0,
      paidCents: paidMap[a.id] ?? 0,
    }))
    .filter((a) => a.owedCents > 0);

  function fmt(cents: number) {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
    }).format(cents / 100);
  }

  return (
    <div className="px-8 py-8 max-w-2xl">
      <Link
        href="/consignment"
        className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900"
      >
        <ChevronLeft className="h-4 w-4" /> Consignment
      </Link>

      <h1 className="text-2xl font-semibold text-stone-900 mb-6">Payments Dashboard</h1>

      {saved === "1" && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Payment recorded.
        </div>
      )}

      {/* Outstanding balances */}
      <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
        Outstanding artist balances
      </h2>
      {artistsWithBalance.length === 0 ? (
        <div className="rounded-xl border border-stone-200 bg-white px-6 py-8 text-center text-sm text-stone-400 mb-6">
          No outstanding balances — all artists paid up.
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50">
                <th className="px-4 py-3 text-left font-medium text-stone-600">Artist</th>
                <th className="px-4 py-3 text-right font-medium text-stone-600">Owed (unpaid)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {artistsWithBalance.map((a) => (
                <tr key={a.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3 font-medium text-stone-900">{a.name}</td>
                  <td className="px-4 py-3 text-right font-semibold text-amber-700">
                    {fmt(a.owedCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expiring agreements */}
      {expiringAgreements.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
            Agreements expiring within 30 days
          </h2>
          <div className="rounded-xl border border-amber-200 bg-amber-50 overflow-hidden mb-6">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-amber-100">
                {expiringAgreements.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-medium text-stone-800">{a.artistName}</td>
                    <td className="px-4 py-3 text-amber-700">Expires {a.endDate}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/consignment/agreements/${a.id}`}
                        className="text-xs underline text-stone-500 hover:text-stone-900"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Record payment form */}
      <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
        Record artist payment
      </h2>
      {error === "invalid" && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Please fill in all required fields.
        </div>
      )}
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <form action={recordArtistPayment} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Artist <span className="text-red-500">*</span>
              </label>
              <select
                name="artistId"
                required
                defaultValue=""
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                <option value="" disabled>Select…</option>
                {artists.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Amount ($AUD) <span className="text-red-500">*</span>
              </label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-stone-500">$</span>
                <input
                  name="amountCents"
                  type="number"
                  min={1}
                  required
                  placeholder="0"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Payment date <span className="text-red-500">*</span>
              </label>
              <input
                name="paymentDate"
                type="date"
                required
                defaultValue={todayStr}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Reference <span className="text-stone-400 font-normal">(optional)</span>
              </label>
              <input
                name="reference"
                type="text"
                maxLength={200}
                placeholder="e.g. EFT ref 12345"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800"
            >
              Record payment
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
