/**
 * Artwork label — printable view (Task #83)
 *
 * Two label sizes selectable via `?size=wall` (10×7 cm) or `?size=backing` (15×10 cm).
 * Opens in a new tab; user prints to PDF via the browser.
 *
 * QR code links to the artwork's public storefront page.
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

type Size = "wall" | "backing";

const SIZE_CONFIG: Record<Size, { label: string; widthMm: number; heightMm: number }> = {
  wall: { label: "Wall Label", widthMm: 100, heightMm: 70 },
  backing: { label: "Backing Board Label", widthMm: 150, heightMm: 100 },
};

export default async function ArtworkLabelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ size?: string }>;
}) {
  const { id } = await params;
  const { size: rawSize } = await searchParams;
  const size: Size = rawSize === "backing" ? "backing" : "wall";
  const config = SIZE_CONFIG[size];

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
  const qrSize = size === "wall" ? 80 : 110;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodeURIComponent(artworkUrl)}`;

  const dimensions =
    artwork.dimensionsW || artwork.dimensionsH
      ? [artwork.dimensionsW, artwork.dimensionsH, artwork.dimensionsD]
          .filter(Boolean)
          .map((d) => `${d} mm`)
          .join(" × ")
      : null;

  const themeColor = tenant.themeColor ?? "#1c1917";
  const isWall = size === "wall";
  const priceFmt =
    artwork.price != null
      ? new Intl.NumberFormat("en-AU", {
          style: "currency",
          currency: "AUD",
          minimumFractionDigits: 0,
        }).format(artwork.price / 100)
      : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${config.label} — ${artwork.title}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          * { box-sizing: border-box; margin: 0; padding: 0; }

          body {
            font-family: 'Inter', sans-serif;
            background: #f5f5f0;
            color: #1c1917;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 32px;
            gap: 16px;
          }

          .print-btn {
            background: ${themeColor};
            color: white;
            border: none;
            border-radius: 8px;
            padding: 10px 18px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
          }

          .label-card {
            background: white;
            width: ${config.widthMm}mm;
            height: ${config.heightMm}mm;
            padding: ${isWall ? "5mm 6mm" : "7mm 8mm"};
            border: 1px solid #e7e5e4;
            border-radius: 4px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
          }

          .label-top { flex: 1; }

          .label-title {
            font-size: ${isWall ? "11pt" : "14pt"};
            font-weight: 700;
            color: #1c1917;
            line-height: 1.2;
            margin-bottom: ${isWall ? "1mm" : "1.5mm"};
          }

          .label-artist {
            font-size: ${isWall ? "8pt" : "10pt"};
            color: #57534e;
            margin-bottom: ${isWall ? "2mm" : "3mm"};
          }

          .label-meta {
            font-size: ${isWall ? "7pt" : "8.5pt"};
            color: #78716c;
            line-height: 1.4;
          }

          .label-price {
            font-size: ${isWall ? "10pt" : "13pt"};
            font-weight: 600;
            color: ${themeColor};
            margin-top: ${isWall ? "2mm" : "3mm"};
          }

          .label-bottom {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            border-top: 1px solid #f5f5f4;
            padding-top: ${isWall ? "2mm" : "3mm"};
            margin-top: ${isWall ? "2mm" : "3mm"};
          }

          .label-gallery {
            font-size: ${isWall ? "6.5pt" : "7.5pt"};
            color: #a8a29e;
            font-weight: 500;
          }

          .label-cert {
            font-size: ${isWall ? "5.5pt" : "6.5pt"};
            color: #d6d3d1;
            font-family: monospace;
          }

          .label-qr img {
            width: ${isWall ? "14mm" : "20mm"};
            height: ${isWall ? "14mm" : "20mm"};
          }

          @media print {
            body { background: white; padding: 0; justify-content: flex-start; }
            .print-btn { display: none; }
            .label-card {
              border: 0.5pt solid #ccc;
              border-radius: 0;
              page-break-inside: avoid;
            }
          }
        `}</style>
      </head>
      <body>
        <button className="print-btn" id="print-btn">
          🖨 Print / Save as PDF
        </button>

        <div className="label-card">
          <div className="label-top">
            <p className="label-title">{artwork.title}</p>
            {artistName && <p className="label-artist">by {artistName}</p>}
            <div className="label-meta">
              {artwork.medium && <div>{artwork.medium}</div>}
              {dimensions && <div>{dimensions}</div>}
              {artwork.isEdition && (
                <div>
                  Edition {artwork.editionNumber} of {artwork.totalEditions}
                </div>
              )}
            </div>
            {priceFmt && <p className="label-price">{priceFmt}</p>}
          </div>

          <div className="label-bottom">
            <div>
              <p className="label-gallery">{tenant.businessName}</p>
              <p className="label-cert">{cert.certificateNumber}</p>
            </div>
            <div className="label-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrUrl} alt="Artwork QR code" />
            </div>
          </div>
        </div>

        <script
          dangerouslySetInnerHTML={{
            __html: `document.querySelector('.print-btn')?.addEventListener('click', () => window.print());`,
          }}
        />
      </body>
    </html>
  );
}
