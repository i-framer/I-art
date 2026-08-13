/**
 * Issue a new Certificate of Authenticity — form page (Task #83)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { artworksTable, tenantsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import { issueCertificate } from "../actions";

export const metadata: Metadata = { title: "Issue Certificate" };

export default async function NewCertificatePage({
  searchParams,
}: {
  searchParams: Promise<{ artworkId?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { artworkId: preselectedId, error } = await searchParams;

  const [tenant, artworks] = await Promise.all([
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
    db
      .select({
        id: artworksTable.id,
        title: artworksTable.title,
        sku: artworksTable.sku,
        status: artworksTable.status,
      })
      .from(artworksTable)
      .where(eq(artworksTable.tenantId, session.tenantId))
      .orderBy(asc(artworksTable.title)),
  ]);

  if (!tenant) redirect("/login");

  return (
    <div className="px-8 py-8 max-w-xl">
      {/* Back link */}
      <Link
        href="/certificates"
        className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900"
      >
        <ChevronLeft className="h-4 w-4" />
        Certificates
      </Link>

      <h1 className="text-2xl font-semibold text-stone-900 mb-1">
        Issue Certificate
      </h1>
      <p className="text-sm text-stone-500 mb-6">
        Issue a Certificate of Authenticity for an artwork in your catalog.
      </p>

      {error === "invalid" && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Please select an artwork.
        </div>
      )}
      {error === "notfound" && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Artwork not found. Please try again.
        </div>
      )}

      <form action={issueCertificate} className="space-y-5">
        {/* Artwork selector */}
        <div>
          <label
            htmlFor="artworkId"
            className="block text-sm font-medium text-stone-700 mb-1"
          >
            Artwork <span className="text-red-500">*</span>
          </label>
          {artworks.length === 0 ? (
            <p className="text-sm text-stone-400">
              No artworks in your catalog.{" "}
              <Link href="/catalog/new" className="underline">
                Add one first.
              </Link>
            </p>
          ) : (
            <select
              id="artworkId"
              name="artworkId"
              required
              defaultValue={preselectedId ?? ""}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-500 focus:outline-none"
            >
              <option value="" disabled>
                Select an artwork…
              </option>
              {artworks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} ({a.sku}){" "}
                  {a.status !== "AVAILABLE" ? `— ${a.status}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Optional buyer name */}
        <div>
          <label
            htmlFor="buyerName"
            className="block text-sm font-medium text-stone-700 mb-1"
          >
            Buyer name{" "}
            <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <input
            id="buyerName"
            name="buyerName"
            type="text"
            maxLength={200}
            placeholder="e.g. Jane Smith"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Issue certificate
          </button>
          <Link
            href="/certificates"
            className="text-sm text-stone-500 hover:text-stone-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
