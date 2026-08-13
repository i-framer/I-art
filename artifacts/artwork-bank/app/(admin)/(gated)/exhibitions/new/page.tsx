/**
 * Create exhibition show  (Task #81)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { ChevronLeft } from "lucide-react";
import { createShow } from "../actions";

export const metadata: Metadata = { title: "New Exhibition" };

export default async function NewExhibitionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { error } = await searchParams;

  return (
    <div className="px-8 py-8 max-w-xl">
      <Link href="/exhibitions" className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900">
        <ChevronLeft className="h-4 w-4" /> Exhibitions
      </Link>

      <h1 className="text-2xl font-semibold text-stone-900 mb-1">New Exhibition</h1>
      <p className="text-sm text-stone-500 mb-6">Create a new show to start planning your floor plan, guest list, and timeline.</p>

      {error === "invalid" && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Please fill in all required fields.
        </div>
      )}

      <form action={createShow} className="space-y-5">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-stone-700 mb-1">
            Show title <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            maxLength={200}
            placeholder="e.g. Summer Group Show 2026"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="venue" className="block text-sm font-medium text-stone-700 mb-1">
            Venue <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <input
            id="venue"
            name="venue"
            type="text"
            maxLength={200}
            placeholder="e.g. Main Gallery, 123 Art St"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="openingDate" className="block text-sm font-medium text-stone-700 mb-1">
              Opening date <span className="text-stone-400 font-normal">(optional)</span>
            </label>
            <input
              id="openingDate"
              name="openingDate"
              type="date"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="closingDate" className="block text-sm font-medium text-stone-700 mb-1">
              Closing date <span className="text-stone-400 font-normal">(optional)</span>
            </label>
            <input
              id="closingDate"
              name="closingDate"
              type="date"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-stone-700 mb-1">
            Notes <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={2000}
            placeholder="Any additional notes about the show…"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm resize-none focus:border-stone-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Create show
          </button>
          <Link href="/exhibitions" className="text-sm text-stone-500 hover:text-stone-900">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
