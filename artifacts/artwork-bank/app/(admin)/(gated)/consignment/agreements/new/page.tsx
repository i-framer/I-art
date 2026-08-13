/**
 * Create consignment agreement — form page  (Task #82)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { representedArtistsTable, tenantsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import { createAgreement } from "../../actions";

export const metadata: Metadata = { title: "New Consignment Agreement" };

export default async function NewAgreementPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { error } = await searchParams;

  const [tenant, artists] = await Promise.all([
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
    db
      .select({ id: representedArtistsTable.id, name: representedArtistsTable.name })
      .from(representedArtistsTable)
      .where(eq(representedArtistsTable.tenantId, session.tenantId))
      .orderBy(asc(representedArtistsTable.name)),
  ]);

  if (!tenant) redirect("/login");

  return (
    <div className="px-8 py-8 max-w-xl">
      <Link href="/consignment" className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900">
        <ChevronLeft className="h-4 w-4" /> Consignment
      </Link>

      <h1 className="text-2xl font-semibold text-stone-900 mb-1">New Agreement</h1>
      <p className="text-sm text-stone-500 mb-6">Set up a consignment agreement with a represented artist.</p>

      {error === "invalid" && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Please fill in all required fields correctly.
        </div>
      )}
      {error === "notfound" && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Artist not found. Please try again.
        </div>
      )}

      <form action={createAgreement} className="space-y-5">
        {/* Artist */}
        <div>
          <label htmlFor="artistId" className="block text-sm font-medium text-stone-700 mb-1">
            Artist <span className="text-red-500">*</span>
          </label>
          {artists.length === 0 ? (
            <p className="text-sm text-stone-400">
              No represented artists yet.{" "}
              <Link href="/catalog/artists" className="underline">Add one first.</Link>
            </p>
          ) : (
            <select
              id="artistId"
              name="artistId"
              required
              defaultValue=""
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-500 focus:outline-none"
            >
              <option value="" disabled>Select an artist…</option>
              {artists.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          )}
        </div>

        {/* Artist % */}
        <div>
          <label htmlFor="artistPct" className="block text-sm font-medium text-stone-700 mb-1">
            Artist's share (%) <span className="text-red-500">*</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="artistPct"
              name="artistPct"
              type="number"
              min={0}
              max={100}
              required
              defaultValue={60}
              className="w-24 rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
            <span className="text-sm text-stone-500">% of each sale goes to the artist</span>
          </div>
        </div>

        {/* Minimum price */}
        <div>
          <label htmlFor="minPriceCents" className="block text-sm font-medium text-stone-700 mb-1">
            Minimum price (AUD) <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-stone-500">$</span>
            <input
              id="minPriceCents"
              name="minPriceCents"
              type="number"
              min={0}
              step={1}
              placeholder="0"
              className="w-32 rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
            <span className="text-xs text-stone-400">(enter dollars — stored in cents)</span>
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="startDate" className="block text-sm font-medium text-stone-700 mb-1">
              Start date <span className="text-stone-400 font-normal">(optional)</span>
            </label>
            <input
              id="startDate"
              name="startDate"
              type="date"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="endDate" className="block text-sm font-medium text-stone-700 mb-1">
              End date <span className="text-stone-400 font-normal">(optional)</span>
            </label>
            <input
              id="endDate"
              name="endDate"
              type="date"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-stone-700 mb-1">
            Notes <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={1000}
            placeholder="Any additional terms or notes…"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm resize-none focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Create agreement
          </button>
          <Link href="/consignment" className="text-sm text-stone-500 hover:text-stone-900">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
