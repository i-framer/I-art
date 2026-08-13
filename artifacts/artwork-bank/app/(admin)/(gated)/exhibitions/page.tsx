/**
 * Exhibition & Show Planner — shows list  (Task #81)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  exhibitionShowsTable,
  exhibitionPlacementsTable,
  exhibitionGuestsTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import { Palette, Plus } from "lucide-react";

export const metadata: Metadata = { title: "Exhibitions" };

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  UPCOMING: { label: "Upcoming", cls: "bg-blue-100 text-blue-700" },
  ACTIVE: { label: "Active", cls: "bg-emerald-100 text-emerald-700" },
  ARCHIVED: { label: "Archived", cls: "bg-stone-100 text-stone-500" },
};

export default async function ExhibitionsPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [tenant, shows] = await Promise.all([
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
    db
      .select({
        id: exhibitionShowsTable.id,
        title: exhibitionShowsTable.title,
        venue: exhibitionShowsTable.venue,
        openingDate: exhibitionShowsTable.openingDate,
        closingDate: exhibitionShowsTable.closingDate,
        status: exhibitionShowsTable.status,
        placementCount: count(exhibitionPlacementsTable.id),
      })
      .from(exhibitionShowsTable)
      .leftJoin(
        exhibitionPlacementsTable,
        eq(exhibitionPlacementsTable.tenantId, exhibitionShowsTable.tenantId),
      )
      .where(eq(exhibitionShowsTable.tenantId, session.tenantId))
      .groupBy(exhibitionShowsTable.id)
      .orderBy(desc(exhibitionShowsTable.createdAt)),
  ]);

  if (!tenant) redirect("/login");

  const upcoming = shows.filter((s) => s.status === "UPCOMING");
  const active = shows.filter((s) => s.status === "ACTIVE");
  const archived = shows.filter((s) => s.status === "ARCHIVED");

  function ShowRow({ show }: { show: (typeof shows)[0] }) {
    const badge = STATUS_BADGE[show.status];
    return (
      <tr className="hover:bg-stone-50 transition-colors">
        <td className="px-4 py-3 font-medium text-stone-900">{show.title}</td>
        <td className="px-4 py-3 text-stone-500 text-sm">{show.venue ?? <span className="italic text-stone-300">—</span>}</td>
        <td className="px-4 py-3 text-stone-500 text-sm">
          {show.openingDate
            ? `${show.openingDate}${show.closingDate ? ` → ${show.closingDate}` : ""}`
            : <span className="italic text-stone-300">TBA</span>}
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge?.cls}`}>
            {badge?.label}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          <Link
            href={`/exhibitions/${show.id}`}
            className="text-xs font-medium text-stone-600 hover:text-stone-900 underline underline-offset-2"
          >
            Open
          </Link>
        </td>
      </tr>
    );
  }

  const hasShows = shows.length > 0;

  return (
    <div className="px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">Exhibitions</h1>
          <p className="text-sm text-stone-500 mt-0.5">Plan shows, manage floor plans, guests, and timelines</p>
        </div>
        <Link
          href="/exhibitions/new"
          className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
        >
          <Plus className="h-4 w-4" /> New show
        </Link>
      </div>

      {!hasShows ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white py-16 text-center">
          <Palette className="h-10 w-10 text-stone-300 mb-3" />
          <p className="text-sm font-medium text-stone-600">No exhibitions yet</p>
          <p className="text-sm text-stone-400 mt-1">Create your first show to start planning.</p>
          <Link
            href="/exhibitions/new"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            <Plus className="h-4 w-4" /> New show
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {[
            { label: "Active", items: active },
            { label: "Upcoming", items: upcoming },
            { label: "Archived", items: archived },
          ]
            .filter(({ items }) => items.length > 0)
            .map(({ label, items }) => (
              <div key={label}>
                <h2 className="text-sm font-semibold text-stone-600 uppercase tracking-wide mb-3">{label}</h2>
                <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-stone-100 bg-stone-50">
                        <th className="px-4 py-3 text-left font-medium text-stone-500">Title</th>
                        <th className="px-4 py-3 text-left font-medium text-stone-500">Venue</th>
                        <th className="px-4 py-3 text-left font-medium text-stone-500">Dates</th>
                        <th className="px-4 py-3 text-left font-medium text-stone-500">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {items.map((s) => <ShowRow key={s.id} show={s} />)}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
