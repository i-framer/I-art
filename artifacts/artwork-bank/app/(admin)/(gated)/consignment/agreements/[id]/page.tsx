/**
 * Consignment agreement detail — items, sales, and action forms  (Task #82)
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  consignmentAgreementsTable,
  consignmentItemsTable,
  consignmentSalesTable,
  representedArtistsTable,
  artworksTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { ChevronLeft, PackageCheck, Plus, DollarSign } from "lucide-react";
import { intakeArtwork, returnArtwork, recordSale, archiveAgreement } from "../../actions";

export const metadata: Metadata = { title: "Agreement" };

export default async function AgreementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [agreement, availableArtworks] = await Promise.all([
    db.query.consignmentAgreementsTable.findFirst({
      where: and(
        eq(consignmentAgreementsTable.id, id),
        eq(consignmentAgreementsTable.tenantId, session.tenantId),
      ),
    }),
    db
      .select({ id: artworksTable.id, title: artworksTable.title, sku: artworksTable.sku })
      .from(artworksTable)
      .where(and(
        eq(artworksTable.tenantId, session.tenantId),
        eq(artworksTable.status, "AVAILABLE"),
      ))
      .orderBy(asc(artworksTable.title)),
  ]);

  if (!agreement) notFound();

  const [artist, items] = await Promise.all([
    db.query.representedArtistsTable.findFirst({
      where: eq(representedArtistsTable.id, agreement.artistId),
    }),
    db
      .select({
        item: consignmentItemsTable,
        artworkTitle: artworksTable.title,
        artworkSku: artworksTable.sku,
        sale: consignmentSalesTable,
      })
      .from(consignmentItemsTable)
      .innerJoin(artworksTable, eq(consignmentItemsTable.artworkId, artworksTable.id))
      .leftJoin(
        consignmentSalesTable,
        eq(consignmentSalesTable.itemId, consignmentItemsTable.id),
      )
      .where(eq(consignmentItemsTable.agreementId, id))
      .orderBy(asc(consignmentItemsTable.createdAt)),
  ]);

  const today = new Date().toISOString().split("T")[0];

  const _inStock = items.filter((i) => i.item.status === "IN_STOCK"); // reserved for future in-stock count display
  const salesTotal = items
    .filter((i) => i.sale)
    .reduce((sum, i) => sum + (i.sale?.salePriceCents ?? 0), 0);
  const artistTotal = items
    .filter((i) => i.sale)
    .reduce((sum, i) => sum + (i.sale?.artistAmountCents ?? 0), 0);

  function fmt(cents: number) {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
      cents / 100,
    );
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <Link href="/consignment" className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900">
        <ChevronLeft className="h-4 w-4" /> Consignment
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">{artist?.name ?? "Agreement"}</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {agreement.artistPct}% artist / {100 - agreement.artistPct}% gallery
            {agreement.endDate && ` · ends ${agreement.endDate}`}
          </p>
        </div>
        {agreement.status === "ACTIVE" && (
          <form action={archiveAgreement}>
            <input type="hidden" name="id" value={id} />
            <button
              type="submit"
              className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs text-stone-500 hover:bg-stone-50 transition-colors"
            >
              Archive
            </button>
          </form>
        )}
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Sales total", value: fmt(salesTotal) },
          { label: "Artist owes", value: fmt(artistTotal) },
          { label: "Gallery share", value: fmt(salesTotal - artistTotal) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-stone-200 bg-white p-4">
            <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">{label}</p>
            <p className="text-lg font-semibold text-stone-900">{value}</p>
          </div>
        ))}
      </div>

      {/* Intake form */}
      {agreement.status === "ACTIVE" && (
        <details className="mb-5 rounded-xl border border-stone-200 bg-white overflow-hidden">
          <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer text-sm font-medium text-stone-700 hover:bg-stone-50">
            <Plus className="h-4 w-4" /> Add artwork to consignment
          </summary>
          <div className="px-4 pb-4 border-t border-stone-100">
            <form action={intakeArtwork} className="flex flex-wrap items-end gap-3 mt-3">
              <input type="hidden" name="agreementId" value={id} />
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Artwork</label>
                <select
                  name="artworkId"
                  required
                  defaultValue=""
                  className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="" disabled>Select…</option>
                  {availableArtworks.map((a) => (
                    <option key={a.id} value={a.id}>{a.title} ({a.sku})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Intake date</label>
                <input
                  name="intakeDate"
                  type="date"
                  required
                  defaultValue={today}
                  className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
              >
                Intake
              </button>
            </form>
          </div>
        </details>
      )}

      {/* Items list */}
      <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
        Consigned works ({items.length})
      </h2>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white py-10 text-center mb-6">
          <PackageCheck className="h-8 w-8 text-stone-300 mb-2" />
          <p className="text-sm text-stone-400">No artworks intaken yet.</p>
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {items.map(({ item, artworkTitle, artworkSku, sale }) => {
            const isSold = item.status === "SOLD";
            const isReturned = item.status === "RETURNED";
            return (
              <div key={item.id} className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-stone-900">{artworkTitle}</p>
                    <p className="text-xs text-stone-400">{artworkSku} · intaken {item.intakeDate}</p>
                    <span className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      isSold ? "bg-emerald-100 text-emerald-700" :
                      isReturned ? "bg-stone-100 text-stone-600" :
                      "bg-blue-100 text-blue-700"
                    }`}>
                      {item.status}
                    </span>
                  </div>
                  {sale && (
                    <div className="text-right">
                      <p className="text-sm font-semibold text-stone-900">{fmt(sale.salePriceCents)}</p>
                      <p className="text-xs text-stone-400">
                        {fmt(sale.artistAmountCents)} to artist · {sale.saleDate}
                      </p>
                    </div>
                  )}
                </div>

                {/* Record sale form */}
                {item.status === "IN_STOCK" && agreement.status === "ACTIVE" && (
                  <details className="mt-3 border-t border-stone-100 pt-3">
                    <summary className="text-xs font-medium text-stone-600 cursor-pointer hover:text-stone-900 flex items-center gap-1">
                      <DollarSign className="h-3 w-3" /> Record sale
                    </summary>
                    <form action={recordSale} className="flex flex-wrap items-end gap-3 mt-3">
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="agreementId" value={id} />
                      <div>
                        <label className="block text-xs font-medium text-stone-600 mb-1">Sale price ($AUD)</label>
                        <div className="flex items-center gap-1">
                          <span className="text-sm text-stone-500">$</span>
                          <input
                            name="salePriceCents"
                            type="number"
                            min={1}
                            required
                            placeholder="0"
                            className="w-28 rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-stone-600 mb-1">Sale date</label>
                        <input
                          name="saleDate"
                          type="date"
                          required
                          defaultValue={today}
                          className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                        />
                      </div>
                      <button type="submit" className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                        Record
                      </button>
                    </form>
                  </details>
                )}

                {/* Return form */}
                {item.status === "IN_STOCK" && agreement.status === "ACTIVE" && (
                  <form action={returnArtwork} className="mt-2 flex items-center gap-2">
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="agreementId" value={id} />
                    <input name="returnDate" type="date" defaultValue={today} className="rounded border border-stone-200 px-2 py-1 text-xs text-stone-600" />
                    <button type="submit" className="text-xs text-stone-400 hover:text-stone-700 underline">Return artwork</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Artist statement link */}
      {artist && items.length > 0 && (
        <div className="mt-2">
          <Link
            href={`/consignment/artists/${artist.id}/statement`}
            target="_blank"
            className="text-sm text-stone-600 hover:text-stone-900 underline underline-offset-2"
          >
            Print artist statement →
          </Link>
        </div>
      )}
    </div>
  );
}
