import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkImagesTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { and, eq, inArray, desc, count } from "drizzle-orm";
import { getTenantBySlug, formatPrice } from "@/lib/tenant-cache";
import { getServeUrl } from "@/lib/object-storage";

const PAGE_SIZE = 24;
const VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as ("AVAILABLE" | "SOLD" | "RESERVED")[];

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  SOLD: { label: "Sold", cls: "bg-stone-900 text-white" },
  RESERVED: { label: "Reserved", cls: "bg-amber-600 text-white" },
};

type SearchParams = { category?: string; page?: string };
type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return {};
  return {
    title: "Gallery",
    description: `Browse original artworks by ${tenant.businessName}.`,
    openGraph: {
      title: `${tenant.businessName} — Gallery`,
      description: `Browse original artworks by ${tenant.businessName}.`,
    },
  };
}

export default async function GalleryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const page = Math.max(1, parseInt(sp.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const themeColor = tenant.themeColor ?? "#1c1917";
  const base = `/t/${slug}`;

  // Fetch categories for filter chips
  const categories = await db.query.artworkCategoriesTable.findMany({
    where: eq(artworkCategoriesTable.tenantId, tenant.id),
    orderBy: (t, { asc }) => [asc(t.name)],
  });

  // Build artwork WHERE conditions
  const conditions = [
    eq(artworksTable.tenantId, tenant.id),
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, VISIBLE_STATUSES),
  ];

  if (sp.category) {
    const idsInCat = await db
      .select({ artworkId: artworkCategoryOnArtworkTable.artworkId })
      .from(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.categoryId, sp.category));
    const ids = idsInCat.map((r) => r.artworkId);
    if (ids.length === 0) {
      // No artworks in this category
      return renderPage({ tenant, themeColor, base, categories, rows: [], total: 0, page, sp, slug });
    }
    conditions.push(inArray(artworksTable.id, ids));
  }

  const whereClause = and(...conditions);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({ artwork: artworksTable, primaryImage: artworkImagesTable })
      .from(artworksTable)
      .leftJoin(
        artworkImagesTable,
        and(
          eq(artworkImagesTable.artworkId, artworksTable.id),
          eq(artworkImagesTable.isPrimary, true),
        ),
      )
      .where(whereClause)
      .orderBy(desc(artworksTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(artworksTable).where(whereClause),
  ]);

  const total = countRow?.count ?? 0;

  // Resolve primary image signed URLs in parallel
  const resolved = await Promise.all(
    rows.map(async ({ artwork, primaryImage }) => ({
      artwork,
      imageUrl: primaryImage
        ? await getServeUrl(primaryImage.objectPath, 3600).catch(() => null)
        : null,
    })),
  );

  return renderPage({ tenant, themeColor, base, categories, rows: resolved, total, page, sp, slug });
}

// ── Render ────────────────────────────────────────────────────────────────────

type Tenant = { businessName: string; themeColor: string | null };
type ArtworkRow = {
  artwork: typeof artworksTable.$inferSelect;
  imageUrl: string | null;
};

function buildUrl(base: string, params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

function renderPage({
  tenant: _tenant,
  themeColor,
  base,
  categories,
  rows,
  total,
  page,
  sp,
  slug: _slug,
}: {
  tenant: Tenant;
  themeColor: string;
  base: string;
  categories: { id: string; name: string }[];
  rows: ArtworkRow[];
  total: number;
  page: number;
  sp: SearchParams;
  slug: string;
}) {
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {/* Gallery heading */}
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-stone-900">Gallery</h1>
        <p className="mt-1 text-stone-500 text-sm">
          {total} {total === 1 ? "work" : "works"} available
        </p>
      </div>

      {/* Category filter chips */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-8">
          <Link
            href={buildUrl(base, { page: "1" })}
            className={`rounded-full px-4 py-1.5 text-sm font-medium border transition-colors ${
              !sp.category
                ? "border-transparent text-white"
                : "border-stone-300 text-stone-600 bg-white hover:border-stone-400"
            }`}
            style={!sp.category ? { backgroundColor: themeColor } : {}}
          >
            All
          </Link>
          {categories.map((cat) => {
            const isActive = sp.category === cat.id;
            return (
              <Link
                key={cat.id}
                href={buildUrl(base, { category: cat.id, page: "1" })}
                className={`rounded-full px-4 py-1.5 text-sm font-medium border transition-colors ${
                  isActive
                    ? "border-transparent text-white"
                    : "border-stone-300 text-stone-600 bg-white hover:border-stone-400"
                }`}
                style={isActive ? { backgroundColor: themeColor } : {}}
              >
                {cat.name}
              </Link>
            );
          })}
        </div>
      )}

      {/* Artwork grid */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-stone-400">
          <p className="text-lg">No artworks found</p>
          {sp.category && (
            <Link href={base} className="mt-3 text-sm underline underline-offset-4">
              Clear filter
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {rows.map(({ artwork, imageUrl }) => {
            const badge = STATUS_BADGE[artwork.status];
            return (
              <Link
                key={artwork.id}
                href={`${base}/${artwork.id}`}
                className="group block"
              >
                {/* Image */}
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

                {/* Info */}
                <div className="mt-3">
                  <p className="font-medium text-stone-900 leading-snug line-clamp-2 group-hover:underline underline-offset-2">
                    {artwork.title}
                  </p>
                  {artwork.medium && (
                    <p className="text-xs text-stone-400 mt-0.5">{artwork.medium}</p>
                  )}
                  {artwork.price && (
                    <p className="mt-1.5 text-sm font-semibold text-stone-800">
                      {formatPrice(artwork.price)}
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
              href={buildUrl(base, { category: sp.category, page: String(page - 1) })}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              ← Previous
            </Link>
          )}
          <span className="text-sm text-stone-500 tabular-nums">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={buildUrl(base, { category: sp.category, page: String(page + 1) })}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
