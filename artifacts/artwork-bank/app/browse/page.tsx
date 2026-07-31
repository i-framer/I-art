import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  tenantsTable,
  representedArtistsTable,
} from "@workspace/db";
import {
  and,
  or,
  eq,
  inArray,
  desc,
  count,
  ilike,
  exists,
  isNotNull,
  sql,
} from "drizzle-orm";
import { formatPrice } from "@/lib/format";
import { getServeUrl } from "@/lib/object-storage";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;
const VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as (
  | "AVAILABLE"
  | "SOLD"
  | "RESERVED"
)[];

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  SOLD: { label: "Sold", cls: "bg-stone-900 text-white" },
  RESERVED: { label: "Reserved", cls: "bg-amber-600 text-white" },
};

export const metadata: Metadata = {
  title: "Browse Artwork",
  description:
    "Discover original artwork for sale from independent galleries, artists, and framers across Australia. Search by artist, category, and location.",
  openGraph: {
    title: "Browse Artwork | Artwork Bank",
    description:
      "Discover original artwork for sale from independent galleries, artists, and framers.",
  },
};

type SearchParams = {
  q?: string;
  sellerType?: string;
  seller?: string;
  artist?: string;
  category?: string;
  location?: string;
  page?: string;
};

import { BrowseFilters } from "./_filters";

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // ── Base visibility conditions ─────────────────────────────────────────────
  const conditions = [
    eq(tenantsTable.storefrontEnabled, true),
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, VISIBLE_STATUSES),
  ];

  // Keyword: title, represented artist name, or seller name
  if (sp.q?.trim()) {
    const pattern = `%${sp.q.trim()}%`;
    conditions.push(
      or(
        ilike(artworksTable.title, pattern),
        ilike(representedArtistsTable.name, pattern),
        ilike(tenantsTable.businessName, pattern),
      )!,
    );
  }

  // Seller type
  if (sp.sellerType === "ARTIST" || sp.sellerType === "FRAMER") {
    conditions.push(eq(tenantsTable.type, sp.sellerType));
  }

  // Specific seller (by slug)
  if (sp.seller) {
    conditions.push(eq(tenantsTable.slug, sp.seller));
  }

  // Artist: represented artist name, or the tenant itself when it's an artist
  if (sp.artist) {
    conditions.push(
      or(
        eq(representedArtistsTable.name, sp.artist),
        and(
          eq(tenantsTable.type, "ARTIST"),
          eq(tenantsTable.businessName, sp.artist),
        ),
      )!,
    );
  }

  // Category (matched by name across tenants)
  if (sp.category) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(artworkCategoryOnArtworkTable)
          .innerJoin(
            artworkCategoriesTable,
            eq(
              artworkCategoriesTable.id,
              artworkCategoryOnArtworkTable.categoryId,
            ),
          )
          .where(
            and(
              eq(artworkCategoryOnArtworkTable.artworkId, artworksTable.id),
              eq(artworkCategoriesTable.name, sp.category),
            ),
          ),
      ),
    );
  }

  // Location (tenant-level; artworks of tenants without a location never match)
  if (sp.location) {
    conditions.push(eq(tenantsTable.location, sp.location));
  }

  const whereClause = and(...conditions);

  const baseQuery = () =>
    db
      .select({
        artwork: artworksTable,
        tenant: {
          slug: tenantsTable.slug,
          businessName: tenantsTable.businessName,
          type: tenantsTable.type,
          location: tenantsTable.location,
        },
        artistName: representedArtistsTable.name,
        primaryImage: artworkImagesTable,
      })
      .from(artworksTable)
      .innerJoin(tenantsTable, eq(tenantsTable.id, artworksTable.tenantId))
      .leftJoin(
        representedArtistsTable,
        eq(representedArtistsTable.id, artworksTable.representedArtistId),
      )
      .leftJoin(
        artworkImagesTable,
        and(
          eq(artworkImagesTable.artworkId, artworksTable.id),
          eq(artworkImagesTable.isPrimary, true),
        ),
      );

  const countQuery = db
    .select({ count: count() })
    .from(artworksTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, artworksTable.tenantId))
    .leftJoin(
      representedArtistsTable,
      eq(representedArtistsTable.id, artworksTable.representedArtistId),
    )
    .where(whereClause);

  // ── Filter options (across enabled storefronts only) ───────────────────────
  const enabledTenants = eq(tenantsTable.storefrontEnabled, true);

  const [rows, [countRow], sellers, artistRows, artistTenants, categoryRows, locationRows] =
    await Promise.all([
      baseQuery()
        .where(whereClause)
        .orderBy(desc(artworksTable.createdAt))
        .limit(PAGE_SIZE)
        .offset(offset),
      countQuery,
      db
        .select({
          slug: tenantsTable.slug,
          businessName: tenantsTable.businessName,
          type: tenantsTable.type,
        })
        .from(tenantsTable)
        .where(enabledTenants)
        .orderBy(tenantsTable.businessName),
      db
        .selectDistinct({ name: representedArtistsTable.name })
        .from(representedArtistsTable)
        .innerJoin(
          tenantsTable,
          eq(tenantsTable.id, representedArtistsTable.tenantId),
        )
        .where(enabledTenants),
      db
        .select({ name: tenantsTable.businessName })
        .from(tenantsTable)
        .where(and(enabledTenants, eq(tenantsTable.type, "ARTIST"))),
      db
        .selectDistinct({ name: artworkCategoriesTable.name })
        .from(artworkCategoriesTable)
        .innerJoin(
          tenantsTable,
          eq(tenantsTable.id, artworkCategoriesTable.tenantId),
        )
        .where(enabledTenants),
      db
        .selectDistinct({ location: tenantsTable.location })
        .from(tenantsTable)
        .where(and(enabledTenants, isNotNull(tenantsTable.location))),
    ]);

  const total = countRow?.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const artists = Array.from(
    new Set([
      ...artistRows.map((r) => r.name),
      ...artistTenants.map((r) => r.name),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  const categories = categoryRows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
  const locations = locationRows
    .map((r) => r.location!)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  // Resolve primary image signed URLs in parallel
  const resolved = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      imageUrl: row.primaryImage
        ? await getServeUrl(row.primaryImage.objectPath, 3600).catch(() => null)
        : null,
    })),
  );

  function pageUrl(p: number) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== "page") params.set(k, v);
    }
    params.set("page", String(p));
    return `/browse?${params.toString()}`;
  }

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
          <Link href="/" className="text-lg font-semibold tracking-tight text-stone-900">
            Artwork Bank
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium">
            <Link href="/browse" className="text-stone-900">
              Browse
            </Link>
            <Link
              href="/login"
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 transition-colors"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-stone-900">Browse artwork</h1>
          <p className="mt-1 text-stone-500 text-sm">
            Original works from independent galleries, artists, and framers.
          </p>
        </div>

        <BrowseFilters
          sellers={sellers}
          artists={artists}
          categories={categories}
          locations={locations}
          total={total}
        />

        {/* Result grid */}
        {resolved.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-stone-400">
            <p className="text-lg">No artworks found</p>
            <p className="mt-1 text-sm">
              Try a different search or clear your filters.
            </p>
            <Link
              href="/browse"
              className="mt-3 text-sm underline underline-offset-4"
            >
              Clear all filters
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {resolved.map(({ artwork, tenant, artistName, imageUrl }) => {
              const badge = STATUS_BADGE[artwork.status];
              const displayArtist =
                artistName ??
                (tenant.type === "ARTIST" ? tenant.businessName : null);
              return (
                <Link
                  key={artwork.id}
                  href={`/t/${tenant.slug}/${artwork.id}`}
                  className="group block"
                >
                  <div className="relative aspect-square overflow-hidden rounded-xl bg-stone-100">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={artwork.title}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <span className="text-xs text-stone-300">No image</span>
                      </div>
                    )}
                    {badge && (
                      <span
                        className={`absolute top-2.5 right-2.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    )}
                  </div>

                  <div className="mt-3">
                    <p className="font-medium text-stone-900 leading-snug line-clamp-2 group-hover:underline underline-offset-2">
                      {artwork.title}
                    </p>
                    {displayArtist && (
                      <p className="text-xs text-stone-500 mt-0.5">
                        {displayArtist}
                      </p>
                    )}
                    {(displayArtist !== tenant.businessName ||
                      tenant.location) && (
                      <p className="text-xs text-stone-400 mt-0.5">
                        {displayArtist !== tenant.businessName
                          ? tenant.businessName
                          : ""}
                        {displayArtist !== tenant.businessName &&
                        tenant.location
                          ? " · "
                          : ""}
                        {tenant.location ?? ""}
                      </p>
                    )}
                    {artwork.price ? (
                      <p className="mt-1.5 text-sm font-semibold text-stone-800">
                        {formatPrice(artwork.price)}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-sm text-stone-400">
                        Price on enquiry
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-12">
            {page > 1 && (
              <Link
                href={pageUrl(page - 1)}
                className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-100 transition-colors"
              >
                ← Previous
              </Link>
            )}
            <span className="text-sm text-stone-500 tabular-nums">
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link
                href={pageUrl(page + 1)}
                className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-100 transition-colors"
              >
                Next →
              </Link>
            )}
          </div>
        )}
      </main>

      <footer className="mt-16 border-t border-stone-200 py-8 text-sm text-stone-400 bg-white">
        <div className="mx-auto max-w-7xl px-6 flex items-center justify-between">
          <span className="font-medium text-stone-500">Artwork Bank</span>
          <Link href="/" className="hover:text-stone-600 transition-colors">
            About the platform
          </Link>
        </div>
      </footer>
    </div>
  );
}
