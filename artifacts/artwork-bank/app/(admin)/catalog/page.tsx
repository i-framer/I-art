import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
  tenantsTable,
} from "@workspace/db";
import {
  and,
  eq,
  or,
  ilike,
  inArray,
  desc,
  count,
  asc,
  sql,
} from "drizzle-orm";
import { Plus, FolderOpen, Users } from "lucide-react";
import { CatalogFilters } from "./_filters";
import { ArtworkList } from "./_list";

export const metadata: Metadata = { title: "Catalog" };

const PAGE_SIZE = 20;

type SearchParams = { q?: string; status?: string; categoryId?: string; artistId?: string; page?: string };

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  const sp = await searchParams;

  const [tenant, allCategories, allArtists] = await Promise.all([
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
    db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
  ]);

  if (!tenant) redirect("/login");

  const page = Math.max(1, parseInt(sp.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  // Build WHERE conditions
  const conditions = [eq(artworksTable.tenantId, session.tenantId)];

  if (sp.status && ["AVAILABLE", "SOLD", "RESERVED", "HIDDEN"].includes(sp.status)) {
    conditions.push(eq(artworksTable.status, sp.status as any));
  }
  if (sp.q) {
    const q = `%${sp.q}%`;
    conditions.push(or(ilike(artworksTable.title, q), ilike(artworksTable.sku, q))!);
  }
  if (sp.artistId) {
    conditions.push(eq(artworksTable.representedArtistId, sp.artistId));
  }
  if (sp.categoryId) {
    const idsInCat = await db
      .select({ artworkId: artworkCategoryOnArtworkTable.artworkId })
      .from(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, sp.categoryId));
    const ids = idsInCat.map((r) => r.artworkId);
    if (ids.length === 0) {
      // No artworks in this category — short-circuit
      return renderPage(tenant.type, allCategories, allArtists, [], 0, page, sp);
    }
    conditions.push(inArray(artworksTable.id, ids));
  }

  const whereClause = and(...conditions);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        artwork: artworksTable,
        primaryImage: artworkImagesTable,
        artistName: representedArtistsTable.name,
      })
      .from(artworksTable)
      .leftJoin(
        artworkImagesTable,
        and(
          eq(artworkImagesTable.artworkId, artworksTable.id),
          eq(artworkImagesTable.isPrimary, true),
        ),
      )
      .leftJoin(
        representedArtistsTable,
        eq(artworksTable.representedArtistId, representedArtistsTable.id),
      )
      .where(whereClause)
      .orderBy(desc(artworksTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(artworksTable).where(whereClause),
  ]);

  const total = countRow?.count ?? 0;

  // Fetch categories for each artwork in a single batch query
  const artworkIds = rows.map((r) => r.artwork.id);
  let catsByArtwork: Record<string, (typeof allCategories)[0][]> = {};
  if (artworkIds.length > 0) {
    const catAssignments = await db
      .select({
        artworkId: artworkCategoryOnArtworkTable.artworkId,
        category: artworkCategoriesTable,
      })
      .from(artworkCategoryOnArtworkTable)
      .innerJoin(
        artworkCategoriesTable,
        eq(artworkCategoryOnArtworkTable.categoryId, artworkCategoriesTable.id),
      )
      .where(inArray(artworkCategoryOnArtworkTable.artworkId, artworkIds));
    catsByArtwork = catAssignments.reduce(
      (acc, row) => {
        if (!acc[row.artworkId]) acc[row.artworkId] = [];
        acc[row.artworkId]!.push(row.category);
        return acc;
      },
      {} as Record<string, (typeof allCategories)[0][]>,
    );
  }

  const listRows = rows.map((r) => ({
    artwork: r.artwork,
    primaryImage: r.primaryImage ?? null,
    categories: catsByArtwork[r.artwork.id] ?? [],
    artistName: r.artistName ?? null,
  }));

  return renderPage(tenant.type, allCategories, allArtists, listRows, total, page, sp);
}

function renderPage(
  tenantType: "ARTIST" | "FRAMER",
  categories: any[],
  artists: any[],
  rows: any[],
  total: number,
  page: number,
  sp: SearchParams,
) {
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (sp.status) params.set("status", sp.status);
    if (sp.categoryId) params.set("categoryId", sp.categoryId);
    if (sp.artistId) params.set("artistId", sp.artistId);
    params.set("page", String(p));
    return `/catalog?${params.toString()}`;
  }

  return (
    <div className="px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">Catalog</h1>
          <p className="text-sm text-stone-500 mt-0.5">Manage your artworks</p>
        </div>
        <div className="flex items-center gap-2">
          {tenantType === "FRAMER" && (
            <Link
              href="/catalog/artists"
              className="flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              <Users className="h-4 w-4" />
              Artists
            </Link>
          )}
          <Link
            href="/catalog/categories"
            className="flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
          >
            <FolderOpen className="h-4 w-4" />
            Categories
          </Link>
          <Link
            href="/catalog/new"
            className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New artwork
          </Link>
        </div>
      </div>

      {/* Filters */}
      <CatalogFilters
        categories={categories}
        artists={artists}
        tenantType={tenantType}
        total={total}
      />

      {/* List */}
      <ArtworkList rows={rows} tenantType={tenantType} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          {page > 1 && (
            <Link
              href={buildPageUrl(page - 1)}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50"
            >
              ← Previous
            </Link>
          )}
          <span className="text-sm text-stone-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={buildPageUrl(page + 1)}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
