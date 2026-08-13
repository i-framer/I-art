/**
 * Certificate of Authenticity — detail page (Task #83)
 * Links to the COA printable view and the label printable views.
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  certificatesTable,
  artworksTable,
  representedArtistsTable,
  artworkImagesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ChevronLeft, FileText, Tag, Printer } from "lucide-react";

export const metadata: Metadata = { title: "Certificate" };

export default async function CertificateDetailPage({
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
      imageUrl: artworkImagesTable.objectPath,
      tenant: tenantsTable,
    })
    .from(certificatesTable)
    .innerJoin(artworksTable, eq(certificatesTable.artworkId, artworksTable.id))
    .innerJoin(tenantsTable, eq(certificatesTable.tenantId, tenantsTable.id))
    .leftJoin(
      representedArtistsTable,
      eq(artworksTable.representedArtistId, representedArtistsTable.id),
    )
    .leftJoin(
      artworkImagesTable,
      and(
        eq(artworkImagesTable.artworkId, artworksTable.id),
        eq(artworkImagesTable.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(certificatesTable.id, id),
        eq(certificatesTable.tenantId, session.tenantId),
      ),
    );

  if (!row) notFound();

  const { cert, artwork, artistName, tenant } = row;

  return (
    <div className="px-8 py-8 max-w-2xl">
      {/* Back */}
      <Link
        href="/certificates"
        className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900"
      >
        <ChevronLeft className="h-4 w-4" />
        Certificates
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">
            {cert.certificateNumber}
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Issued{" "}
            {cert.issuedAt.toLocaleDateString("en-AU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      {/* Summary card */}
      <div className="rounded-xl border border-stone-200 bg-white p-6 mb-6 space-y-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
              Artwork
            </p>
            <p className="font-medium text-stone-900">{artwork.title}</p>
            <p className="text-stone-400 text-xs">{artwork.sku}</p>
          </div>
          {artistName && (
            <div>
              <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
                Artist
              </p>
              <p className="font-medium text-stone-900">{artistName}</p>
            </div>
          )}
          {artwork.medium && (
            <div>
              <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
                Medium
              </p>
              <p className="text-stone-700">{artwork.medium}</p>
            </div>
          )}
          {(artwork.dimensionsW || artwork.dimensionsH) && (
            <div>
              <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
                Dimensions
              </p>
              <p className="text-stone-700">
                {[artwork.dimensionsW, artwork.dimensionsH, artwork.dimensionsD]
                  .filter(Boolean)
                  .map((d) => `${d} mm`)
                  .join(" × ")}
              </p>
            </div>
          )}
          {cert.buyerName && (
            <div>
              <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
                Issued to
              </p>
              <p className="text-stone-700">{cert.buyerName}</p>
            </div>
          )}
          <div>
            <p className="text-stone-500 text-xs uppercase tracking-wide mb-0.5">
              Gallery
            </p>
            <p className="text-stone-700">{tenant.businessName}</p>
          </div>
        </div>
      </div>

      {/* Print options */}
      <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide mb-3">
        Print / Download
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link
          href={`/certificates/${id}/coa`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-white p-5 text-center hover:border-stone-400 hover:bg-stone-50 transition-colors"
        >
          <FileText className="h-8 w-8 text-stone-400" />
          <span className="text-sm font-medium text-stone-800">
            Certificate of Authenticity
          </span>
          <span className="text-xs text-stone-400">
            Full COA — A4 print / PDF
          </span>
        </Link>

        <Link
          href={`/certificates/${id}/label?size=wall`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-white p-5 text-center hover:border-stone-400 hover:bg-stone-50 transition-colors"
        >
          <Tag className="h-8 w-8 text-stone-400" />
          <span className="text-sm font-medium text-stone-800">Wall label</span>
          <span className="text-xs text-stone-400">
            10 × 7 cm — beside the artwork
          </span>
        </Link>

        <Link
          href={`/certificates/${id}/label?size=backing`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col items-center gap-2 rounded-xl border border-stone-200 bg-white p-5 text-center hover:border-stone-400 hover:bg-stone-50 transition-colors"
        >
          <Printer className="h-8 w-8 text-stone-400" />
          <span className="text-sm font-medium text-stone-800">
            Backing board label
          </span>
          <span className="text-xs text-stone-400">
            15 × 10 cm — on the reverse
          </span>
        </Link>
      </div>
    </div>
  );
}
