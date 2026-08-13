/**
 * Certificates of Authenticity — list page  (Task #83)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  certificatesTable,
  artworksTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { Award, Plus } from "lucide-react";

export const metadata: Metadata = { title: "Certificates" };

export default async function CertificatesPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [tenant, certs] = await Promise.all([
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
    db
      .select({
        id: certificatesTable.id,
        certificateNumber: certificatesTable.certificateNumber,
        buyerName: certificatesTable.buyerName,
        issuedAt: certificatesTable.issuedAt,
        artworkTitle: artworksTable.title,
        artworkSku: artworksTable.sku,
      })
      .from(certificatesTable)
      .innerJoin(
        artworksTable,
        eq(certificatesTable.artworkId, artworksTable.id),
      )
      .where(eq(certificatesTable.tenantId, session.tenantId))
      .orderBy(desc(certificatesTable.issuedAt)),
  ]);

  if (!tenant) redirect("/login");

  return (
    <div className="px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">
            Certificates
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Certificates of Authenticity issued for your artworks
          </p>
        </div>
        <Link
          href="/certificates/new"
          className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Issue certificate
        </Link>
      </div>

      {/* List */}
      {certs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white py-16 text-center">
          <Award className="h-10 w-10 text-stone-300 mb-3" />
          <p className="text-sm font-medium text-stone-600">
            No certificates issued yet
          </p>
          <p className="text-sm text-stone-400 mt-1 max-w-xs">
            Issue a Certificate of Authenticity from any artwork to get started.
          </p>
          <Link
            href="/certificates/new"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Issue certificate
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50">
                <th className="px-4 py-3 text-left font-medium text-stone-600">
                  Certificate #
                </th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">
                  Artwork
                </th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">
                  Issued to
                </th>
                <th className="px-4 py-3 text-left font-medium text-stone-600">
                  Date issued
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {certs.map((cert) => (
                <tr key={cert.id} className="hover:bg-stone-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-stone-700">
                    {cert.certificateNumber}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-stone-900">
                      {cert.artworkTitle}
                    </p>
                    <p className="text-xs text-stone-400">{cert.artworkSku}</p>
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {cert.buyerName ?? (
                      <span className="text-stone-400 italic">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {cert.issuedAt.toLocaleDateString("en-AU", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/certificates/${cert.id}`}
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
    </div>
  );
}
