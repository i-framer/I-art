/**
 * Certificate of Authenticity — printable COA view (Task #83)
 *
 * Opens in a new tab. The user clicks "Print / Save as PDF" to generate the PDF
 * using the browser's built-in print-to-PDF functionality.
 *
 * QR code links to the artwork's public storefront page and is generated via
 * the qrserver.com free API (no backend dependency).
 */
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  certificatesTable,
  artworksTable,
  representedArtistsTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getPlatformBaseUrl } from "@/lib/base-url";

export default async function CertificateCOAPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [row] = await db
    .select({
      cert: certificatesTable,
      artwork: artworksTable,
      artistName: representedArtistsTable.name,
      tenant: tenantsTable,
    })
    .from(certificatesTable)
    .innerJoin(artworksTable, eq(certificatesTable.artworkId, artworksTable.id))
    .innerJoin(tenantsTable, eq(certificatesTable.tenantId, tenantsTable.id))
    .leftJoin(
      representedArtistsTable,
      eq(artworksTable.representedArtistId, representedArtistsTable.id),
    )
    .where(
      and(
        eq(certificatesTable.id, id),
        eq(certificatesTable.tenantId, session.tenantId),
      ),
    );

  if (!row) notFound();

  const { cert, artwork, artistName, tenant } = row;

  const base = getPlatformBaseUrl() ?? "https://i-art.com.au";
  const artworkUrl = `${base}/t/${tenant.slug}/artworks/${artwork.id}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(artworkUrl)}`;

  const issueDate = cert.issuedAt.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const dimensions =
    artwork.dimensionsW || artwork.dimensionsH
      ? [artwork.dimensionsW, artwork.dimensionsH, artwork.dimensionsD]
          .filter(Boolean)
          .map((d) => `${d} mm`)
          .join(" × ")
      : null;

  const themeColor = tenant.themeColor ?? "#1c1917"; // stone-900 fallback

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`COA — ${cert.certificateNumber}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

          * { box-sizing: border-box; margin: 0; padding: 0; }

          body {
            font-family: 'Inter', sans-serif;
            background: #f5f5f0;
            color: #1c1917;
            padding: 32px;
          }

          .page {
            background: white;
            width: 210mm;
            min-height: 297mm;
            margin: 0 auto;
            padding: 20mm 24mm;
            position: relative;
          }

          .header-bar {
            background: ${themeColor};
            margin: -20mm -24mm 16mm;
            padding: 10mm 24mm;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .header-bar .gallery-name {
            color: white;
            font-size: 18pt;
            font-weight: 700;
            letter-spacing: -0.02em;
          }

          .header-bar .cert-label {
            color: rgba(255,255,255,0.7);
            font-size: 8pt;
            font-weight: 500;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            text-align: right;
          }

          .title-block {
            margin-bottom: 10mm;
          }

          .coa-title {
            font-size: 10pt;
            font-weight: 500;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: #78716c;
            margin-bottom: 4mm;
          }

          .artwork-title {
            font-size: 22pt;
            font-weight: 700;
            color: #1c1917;
            line-height: 1.2;
            margin-bottom: 2mm;
          }

          .artist-name {
            font-size: 13pt;
            color: #57534e;
            font-weight: 400;
          }

          .divider {
            border: none;
            border-top: 1px solid #e7e5e4;
            margin: 8mm 0;
          }

          .fields {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6mm 10mm;
            margin-bottom: 10mm;
          }

          .field-label {
            font-size: 7pt;
            font-weight: 600;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: #a8a29e;
            margin-bottom: 1.5mm;
          }

          .field-value {
            font-size: 10pt;
            color: #1c1917;
            line-height: 1.4;
          }

          .statement {
            background: #fafaf9;
            border: 1px solid #e7e5e4;
            border-radius: 6px;
            padding: 6mm 8mm;
            margin-bottom: 10mm;
            font-size: 9pt;
            color: #57534e;
            line-height: 1.6;
          }

          .statement strong {
            color: #1c1917;
          }

          .qr-section {
            display: flex;
            align-items: flex-start;
            gap: 6mm;
            margin-bottom: 10mm;
          }

          .qr-section img {
            width: 22mm;
            height: 22mm;
            border: 1px solid #e7e5e4;
            border-radius: 4px;
          }

          .qr-caption {
            font-size: 7.5pt;
            color: #78716c;
            line-height: 1.5;
            padding-top: 1mm;
          }

          .qr-caption a {
            color: #1c1917;
            word-break: break-all;
          }

          .footer {
            position: absolute;
            bottom: 12mm;
            left: 24mm;
            right: 24mm;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid #e7e5e4;
            padding-top: 4mm;
          }

          .cert-number {
            font-size: 7.5pt;
            color: #a8a29e;
            font-family: monospace;
          }

          .issue-date {
            font-size: 7.5pt;
            color: #a8a29e;
          }

          .print-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            background: ${themeColor};
            color: white;
            border: none;
            border-radius: 8px;
            padding: 10px 18px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: 16px;
          }

          .screen-only { }

          @media print {
            body { background: white; padding: 0; }
            .page { width: 100%; min-height: 100vh; margin: 0; padding: 15mm 18mm; }
            .header-bar { margin: -15mm -18mm 14mm; padding: 10mm 18mm; }
            .footer { position: fixed; bottom: 8mm; left: 18mm; right: 18mm; }
            .screen-only { display: none !important; }
          }
        `}</style>
      </head>
      <body>
        <div className="screen-only" style={{ textAlign: "center", marginBottom: "16px" }}>
          <button className="print-btn" id="print-btn">
            🖨 Print / Save as PDF
          </button>
        </div>

        <div className="page">
          {/* Header */}
          <div className="header-bar">
            <span className="gallery-name">{tenant.businessName}</span>
            <div className="cert-label">
              Certificate of<br />Authenticity
            </div>
          </div>

          {/* Title block */}
          <div className="title-block">
            <p className="coa-title">Certificate of Authenticity</p>
            <h1 className="artwork-title">{artwork.title}</h1>
            {artistName && <p className="artist-name">by {artistName}</p>}
          </div>

          <hr className="divider" />

          {/* Artwork details */}
          <div className="fields">
            {artwork.medium && (
              <div>
                <p className="field-label">Medium</p>
                <p className="field-value">{artwork.medium}</p>
              </div>
            )}
            {dimensions && (
              <div>
                <p className="field-label">Dimensions</p>
                <p className="field-value">{dimensions}</p>
              </div>
            )}
            {artwork.isEdition && (
              <div>
                <p className="field-label">Edition</p>
                <p className="field-value">
                  {artwork.editionNumber} of {artwork.totalEditions}
                </p>
              </div>
            )}
            {artwork.sku && (
              <div>
                <p className="field-label">Reference / SKU</p>
                <p className="field-value">{artwork.sku}</p>
              </div>
            )}
            {cert.buyerName && (
              <div>
                <p className="field-label">Issued to</p>
                <p className="field-value">{cert.buyerName}</p>
              </div>
            )}
            <div>
              <p className="field-label">Date issued</p>
              <p className="field-value">{issueDate}</p>
            </div>
          </div>

          {/* Authenticity statement */}
          <div className="statement">
            This is to certify that the work described above is an original
            artwork produced by{" "}
            <strong>{artistName ?? tenant.businessName}</strong> and is offered
            for sale or has been sold by{" "}
            <strong>{tenant.businessName}</strong>.{" "}
            {cert.buyerName
              ? `This certificate has been issued to ${cert.buyerName}.`
              : ""}
            {tenant.contactEmail
              ? ` For enquiries, contact ${tenant.contactEmail}.`
              : ""}
          </div>

          {/* QR code */}
          <div className="qr-section">
            {/* img is intentional here — print/PDF layout requires native img */}
            {/* eslint-disable-line */}
            <img src={qrUrl} alt="Artwork page QR code" />
            <div className="qr-caption">
              <strong style={{ color: "#1c1917" }}>Scan to view artwork online</strong>
              <br />
              <a href={artworkUrl}>{artworkUrl}</a>
            </div>
          </div>

          {/* Footer */}
          <div className="footer">
            <span className="cert-number">{cert.certificateNumber}</span>
            <span className="issue-date">Issued {issueDate}</span>
          </div>
        </div>

        {/* Print button script */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              document.querySelector('.print-btn')?.addEventListener('click', () => window.print());
            `,
          }}
        />
      </body>
    </html>
  );
}
