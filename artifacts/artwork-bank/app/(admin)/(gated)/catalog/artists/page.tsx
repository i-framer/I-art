import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  representedArtistsTable,
  tenantsTable,
  artworksTable,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { ArtistsClient } from "./_artists";
import { ChevronRight } from "lucide-react";

export const metadata: Metadata = { title: "Represented Artists" };

export default async function ArtistsPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });

  if (!tenant) redirect("/login");

  // Only FRAMER tenants should access this page
  if (tenant.type !== "FRAMER") {
    redirect("/catalog");
  }

  const artists = await db.query.representedArtistsTable.findMany({
    where: eq(representedArtistsTable.tenantId, session.tenantId),
    orderBy: (t, { asc }) => [asc(t.name)],
  });

  // Get artwork counts per artist
  const countRows = await db
    .select({ artistId: artworksTable.representedArtistId, count: count() })
    .from(artworksTable)
    .where(eq(artworksTable.tenantId, session.tenantId))
    .groupBy(artworksTable.representedArtistId);

  const countMap = Object.fromEntries(
    countRows
      .filter((r) => r.artistId)
      .map((r) => [r.artistId!, r.count]),
  );

  const artistsWithCount = artists.map((a) => ({
    ...a,
    artworkCount: countMap[a.id] ?? 0,
  }));

  return (
    <div className="px-8 py-8 max-w-2xl">
      <nav className="flex items-center gap-1.5 text-sm text-stone-500 mb-4">
        <Link href="/catalog" className="hover:text-stone-900 transition-colors">
          Catalog
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-stone-900">Represented Artists</span>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Represented Artists</h1>
        <p className="text-sm text-stone-500 mt-1">
          Manage artists on consignment. Artworks can be linked to a represented artist.
        </p>
      </div>
      <ArtistsClient initialArtists={artistsWithCount} />
    </div>
  );
}
