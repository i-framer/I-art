/**
 * Consignment & Commission Tracker — agreements list  (Task #82)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  consignmentAgreementsTable,
  representedArtistsTable,
  consignmentItemsTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import { Handshake, Plus, AlertCircle } from "lucide-react";

export const metadata: Metadata = { title: "Consignment" };

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "Active", cls: "bg-emerald-100 text-emerald-700" },
  EXPIRED: { label: "Expired", cls: "bg-amber-100 text-amber-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-red-100 text-red-700" },
};

export default async function ConsignmentPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [tenant, agreements] = await Promise.all([
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
    db
      .select({
        id: consignmentAgreementsTable.id,
        artistPct: consignmentAgreementsTable.artistPct,
        status: consignmentAgreementsTable.status,
        startDate: consignmentAgreementsTable.startDate,
        endDate: consignmentAgreementsTable.endDate,
        artistName: representedArtistsTable.name,
        artistId: representedArtistsTable.id,
        itemCount: count(consignmentItemsTable.id),
      })
      .from(consignmentAgreementsTable)
      .innerJoin(
        representedArtistsTable,
        eq(consignmentAgreementsTable.artistId, representedArtistsTable.id),
      )
      .leftJoin(
        consignmentItemsTable,
        eq(consignmentItemsTable.agreementId, consignmentAgreementsTable.id),
      )
      .where(eq(consignmentAgreementsTable.tenantId, session.tenantId))
      .groupBy(
        consignmentAgreementsTable.id,
        representedArtistsTable.name,
        representedArtistsTable.id,
      )
      .orderBy(desc(consignmentAgreementsTable.createdAt)),
  ]);

  if (!tenant) redirect("/login");

  const active = agreements.filter((a) => a.status === "ACTIVE");
  const archived = agreements.filter((a) => a.status !== "ACTIVE");

  return (
    <div className="px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">Consignment</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Manage artwork consignment agreements and artist commissions
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/consignment/payments"
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
          >
            Payments Dashboard
          </Link>
          <Link
            href="/consignment/agreements/new"
            className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New agreement
          </Link>
        </div>
      </div>

      {/* Active agreements */}
      <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
        Active agreements
      </h2>
      {active.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white py-12 text-center mb-6">
          <Handshake className="h-9 w-9 text-stone-300 mb-3" />
          <p className="text-sm font-medium text-stone-600">
            No active agreements
          </p>
          <p className="text-sm text-stone-400 mt-1">
            Create a consignment agreement with a represented artist.
          </p>
          <Link
            href="/consignment/agreements/new"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New agreement
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50">
                <th className="px-4 py-3 text-left font-medium text-stone-600">Artist</th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">Split</th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">Term</th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">Works</th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {active.map((a) => (
                <tr key={a.id} className="hover:bg-stone-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-stone-900">{a.artistName}</td>
                  <td className="px-4 py-3 text-stone-600">
                    {a.artistPct}% / {100 - a.artistPct}%
                    <span className="text-xs text-stone-400 ml-1">(artist/gallery)</span>
                  </td>
                  <td className="px-4 py-3 text-stone-600 text-xs">
                    {a.startDate || a.endDate
                      ? `${a.startDate ?? "—"} → ${a.endDate ?? "—"}`
                      : <span className="text-stone-400 italic">Open-ended</span>}
                  </td>
                  <td className="px-4 py-3 text-stone-600">{a.itemCount}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[a.status]?.cls}`}>
                      {STATUS_BADGE[a.status]?.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/consignment/agreements/${a.id}`}
                      className="text-xs font-medium text-stone-600 hover:text-stone-900 underline underline-offset-2"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Archived */}
      {archived.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-stone-500 uppercase tracking-wide mb-3">
            Archived
          </h2>
          <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-stone-100">
                {archived.map((a) => (
                  <tr key={a.id} className="hover:bg-stone-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-stone-500">{a.artistName}</td>
                    <td className="px-4 py-3 text-stone-400">{a.artistPct}% artist</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[a.status]?.cls}`}>
                        {STATUS_BADGE[a.status]?.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/consignment/agreements/${a.id}`}
                        className="text-xs font-medium text-stone-400 hover:text-stone-700 underline underline-offset-2"
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
    </div>
  );
}
