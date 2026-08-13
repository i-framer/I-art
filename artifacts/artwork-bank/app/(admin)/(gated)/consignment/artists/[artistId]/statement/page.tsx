/**
 * Artist consignment statement — print-friendly page  (Task #82)
 *
 * Opens in a new tab. Lists all sales for a represented artist
 * with artist/gallery split breakdown.  The user prints to PDF.
 */
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  consignmentAgreementsTable,
  consignmentItemsTable,
  consignmentSalesTable,
  representedArtistsTable,
  artworksTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

export default async function ArtistStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ artistId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { artistId } = await params;
  const { from: fromDate, to: toDate } = await searchParams;
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [artist, tenant] = await Promise.all([
    db.query.representedArtistsTable.findFirst({
      where: and(
        eq(representedArtistsTable.id, artistId),
        eq(representedArtistsTable.tenantId, session.tenantId),
      ),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
  ]);

  if (!artist || !tenant) notFound();

  // Fetch all sales for this artist
  const rows = await db
    .select({
      sale: consignmentSalesTable,
      artworkTitle: artworksTable.title,
      artworkSku: artworksTable.sku,
      agreementArtistPct: consignmentAgreementsTable.artistPct,
    })
    .from(consignmentSalesTable)
    .innerJoin(
      consignmentItemsTable,
      eq(consignmentSalesTable.itemId, consignmentItemsTable.id),
    )
    .innerJoin(artworksTable, eq(consignmentItemsTable.artworkId, artworksTable.id))
    .innerJoin(
      consignmentAgreementsTable,
      eq(consignmentItemsTable.agreementId, consignmentAgreementsTable.id),
    )
    .where(
      and(
        eq(consignmentAgreementsTable.artistId, artistId),
        eq(consignmentAgreementsTable.tenantId, session.tenantId),
      ),
    )
    .orderBy(asc(consignmentSalesTable.saleDate));

  const filteredRows = rows.filter((r) => {
    if (fromDate && r.sale.saleDate < fromDate) return false;
    if (toDate && r.sale.saleDate > toDate) return false;
    return true;
  });

  const totalSale = filteredRows.reduce((s, r) => s + r.sale.salePriceCents, 0);
  const totalArtist = filteredRows.reduce((s, r) => s + r.sale.artistAmountCents, 0);
  const totalGallery = filteredRows.reduce((s, r) => s + r.sale.galleryAmountCents, 0);

  function fmt(cents: number) {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
      cents / 100,
    );
  }

  const printDate = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const themeColor = tenant.themeColor ?? "#1c1917";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Statement — ${artist.name}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Inter', sans-serif; background: #f5f5f0; color: #1c1917; padding: 32px; }
          .page { background: white; width: 210mm; margin: 0 auto; padding: 18mm 22mm; }
          .header { border-bottom: 2px solid ${themeColor}; padding-bottom: 6mm; margin-bottom: 8mm; display: flex; justify-content: space-between; align-items: flex-end; }
          .gallery-name { font-size: 14pt; font-weight: 700; color: ${themeColor}; }
          .statement-title { font-size: 9pt; color: #78716c; text-align: right; }
          .artist-block { margin-bottom: 8mm; }
          .artist-name { font-size: 16pt; font-weight: 700; margin-bottom: 1mm; }
          .sub { font-size: 9pt; color: #78716c; }
          table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 8mm; }
          th { text-align: left; padding: 3mm 4mm; border-bottom: 1px solid #e7e5e4; font-size: 7pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #a8a29e; }
          td { padding: 2.5mm 4mm; border-bottom: 1px solid #f5f5f4; vertical-align: top; }
          .text-right { text-align: right; }
          .totals-row { font-weight: 600; background: #fafaf9; }
          .print-btn { display: block; text-align: center; margin-bottom: 16px; }
          .print-btn button { background: ${themeColor}; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; cursor: pointer; }
          @media print {
            body { background: white; padding: 0; }
            .page { width: 100%; margin: 0; padding: 12mm 16mm; }
            .print-btn { display: none; }
          }
        `}</style>
      </head>
      <body>
        <div className="print-btn">
          <button id="print-btn">🖨 Print / Save as PDF</button>
        </div>
        <div className="page">
          <div className="header">
            <div className="gallery-name">{tenant.businessName}</div>
            <div className="statement-title">
              Consignment Statement<br />
              Printed {printDate}
            </div>
          </div>

          <div className="artist-block">
            <h1 className="artist-name">{artist.name}</h1>
            <p className="sub">
              {filteredRows.length} sale{filteredRows.length !== 1 ? "s" : ""}
              {fromDate || toDate ? ` · ${fromDate ?? "all"} → ${toDate ?? "present"}` : " · all time"}
            </p>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Artwork</th>
                <th>Split</th>
                <th className="text-right">Sale price</th>
                <th className="text-right">Artist amount</th>
                <th className="text-right">Gallery amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "#a8a29e", padding: "8mm" }}>
                    No sales in this period.
                  </td>
                </tr>
              ) : (
                filteredRows.map(({ sale, artworkTitle, artworkSku, agreementArtistPct }) => (
                  <tr key={sale.id}>
                    <td>{sale.saleDate}</td>
                    <td>
                      <div>{artworkTitle}</div>
                      <div style={{ color: "#a8a29e", fontSize: "7.5pt" }}>{artworkSku}</div>
                    </td>
                    <td style={{ color: "#78716c" }}>{agreementArtistPct}% / {100 - agreementArtistPct}%</td>
                    <td className="text-right">{fmt(sale.salePriceCents)}</td>
                    <td className="text-right" style={{ color: "#059669" }}>{fmt(sale.artistAmountCents)}</td>
                    <td className="text-right">{fmt(sale.galleryAmountCents)}</td>
                  </tr>
                ))
              )}
              {filteredRows.length > 0 && (
                <tr className="totals-row">
                  <td colSpan={3} style={{ paddingTop: "4mm" }}>Total</td>
                  <td className="text-right" style={{ paddingTop: "4mm" }}>{fmt(totalSale)}</td>
                  <td className="text-right" style={{ paddingTop: "4mm", color: "#059669" }}>{fmt(totalArtist)}</td>
                  <td className="text-right" style={{ paddingTop: "4mm" }}>{fmt(totalGallery)}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ borderTop: "1px solid #e7e5e4", paddingTop: "4mm", fontSize: "7.5pt", color: "#a8a29e" }}>
            {tenant.businessName}{tenant.contactEmail ? ` · ${tenant.contactEmail}` : ""}
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `document.getElementById('print-btn')?.addEventListener('click', () => window.print());` }} />
      </body>
    </html>
  );
}
