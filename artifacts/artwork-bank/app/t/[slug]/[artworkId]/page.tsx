import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkImagesTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { getTenantBySlug, formatPrice, formatDimensions } from "@/lib/tenant-cache";
import { getServeUrl } from "@/lib/object-storage";
import { ImageCarousel } from "../_components/image-carousel";
import { BuyNowButton } from "../_components/buy-now-button";

type Props = {
  params: Promise<{ slug: string; artworkId: string }>;
  searchParams: Promise<{ cancelled?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, artworkId } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return {};
  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenant.id),
      eq(artworksTable.showInGallery, true),
    ),
  });
  if (!artwork) return {};
  const primaryImage = await db.query.artworkImagesTable.findFirst({
    where: and(
      eq(artworkImagesTable.artworkId, artworkId),
      eq(artworkImagesTable.isPrimary, true),
    ),
  });
  const ogImage = primaryImage
    ? await getServeUrl(primaryImage.objectPath, 3600).catch(() => null)
    : null;
  return {
    title: artwork.title,
    description: artwork.notes?.slice(0, 160) ?? `${artwork.medium ?? ""} by ${tenant.businessName}`.trim(),
    openGraph: {
      title: `${artwork.title} — ${tenant.businessName}`,
      description: artwork.notes?.slice(0, 160) ?? undefined,
      images: ogImage ? [{ url: ogImage, width: 1200, height: 900 }] : [],
    },
  };
}

const CONDITION_LABELS: Record<string, string> = {
  EXCELLENT: "Excellent",
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Poor",
};

export default async function ArtworkDetailPage({ params, searchParams }: Props) {
  const { slug, artworkId } = await params;
  const { cancelled } = await searchParams;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const base = `/t/${slug}`;
  const themeColor = tenant.themeColor ?? "#1c1917";

  // Fetch artwork (only show gallery-visible items)
  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenant.id),
      eq(artworksTable.showInGallery, true),
    ),
  });
  if (!artwork) notFound();

  // Fetch all images + represented artist in parallel
  const [images, representedArtist] = await Promise.all([
    db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.artworkId, artworkId),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
    }),
    artwork.representedArtistId
      ? db.query.representedArtistsTable.findFirst({
          where: eq(representedArtistsTable.id, artwork.representedArtistId),
        })
      : Promise.resolve(null),
  ]);

  // Resolve signed URLs for all images
  const resolvedImages = await Promise.all(
    images.map(async (img) => ({
      url: await getServeUrl(img.objectPath, 3600).catch(() => ""),
      filename: img.filename,
    })),
  );

  const isSold = artwork.status === "SOLD";
  const isReserved = artwork.status === "RESERVED";
  const dimensions = formatDimensions(artwork.dimensionsW, artwork.dimensionsH, artwork.dimensionsD);

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-stone-500 mb-8">
        <Link href={base} className="hover:text-stone-900 transition-colors">
          Gallery
        </Link>
        <span className="text-stone-300">/</span>
        <span className="text-stone-700 truncate max-w-xs">{artwork.title}</span>
      </nav>

      {/* Checkout cancelled flash */}
      {cancelled && (
        <div className="mb-6 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          Your checkout was cancelled — no payment was taken.
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        {/* ── Left: Images ── */}
        <div>
          <ImageCarousel images={resolvedImages} />
        </div>

        {/* ── Right: Info ── */}
        <div className="flex flex-col gap-6">
          {/* Status badges */}
          <div className="flex items-center gap-2">
            {isSold && (
              <span className="rounded-full bg-stone-900 text-white px-3 py-1 text-xs font-semibold">
                Sold
              </span>
            )}
            {isReserved && (
              <span className="rounded-full bg-amber-600 text-white px-3 py-1 text-xs font-semibold">
                Reserved
              </span>
            )}
            {artwork.isEdition && artwork.editionNumber && artwork.totalEditions && (
              <span className="rounded-full bg-stone-100 text-stone-600 px-3 py-1 text-xs font-semibold">
                Edition {artwork.editionNumber} of {artwork.totalEditions}
              </span>
            )}
          </div>

          {/* Title */}
          <div>
            <h1 className="text-3xl font-semibold text-stone-900 leading-tight">
              {artwork.title}
            </h1>
            {/* Represented artist */}
            {representedArtist && (
              <p className="mt-2 text-base text-stone-600 italic">
                by {representedArtist.name}
              </p>
            )}
          </div>

          {/* Price */}
          {artwork.price && (
            <p className="text-2xl font-semibold text-stone-900">
              {formatPrice(artwork.price)}
              {isSold && (
                <span className="ml-2 text-sm font-normal text-stone-400 line-through">
                  sold
                </span>
              )}
            </p>
          )}

          {/* CTA */}
          <div>
            {isSold ? (
              <div className="w-full rounded-xl bg-stone-100 py-4 text-center text-stone-500 text-sm font-medium">
                This piece has been sold
              </div>
            ) : isReserved ? (
              <div className="w-full rounded-xl bg-amber-50 py-4 text-center text-amber-700 text-sm font-medium border border-amber-200">
                Currently reserved — contact us for availability
              </div>
            ) : (
              <BuyNowButton
                artworkId={artworkId}
                slug={slug}
                tenantType={tenant.type}
                price={artwork.price!}
                themeColor={themeColor}
              />
            )}
          </div>

          {/* Divider */}
          <hr className="border-stone-200" />

          {/* Details table */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            {artwork.medium && (
              <>
                <dt className="text-stone-500">Medium</dt>
                <dd className="text-stone-900 font-medium">{artwork.medium}</dd>
              </>
            )}
            {dimensions && (
              <>
                <dt className="text-stone-500">Dimensions</dt>
                <dd className="text-stone-900 font-medium">{dimensions}</dd>
              </>
            )}
            {artwork.condition && (
              <>
                <dt className="text-stone-500">Condition</dt>
                <dd className="text-stone-900 font-medium">
                  {CONDITION_LABELS[artwork.condition] ?? artwork.condition}
                </dd>
              </>
            )}
            {artwork.isEdition && artwork.editionNumber && artwork.totalEditions && (
              <>
                <dt className="text-stone-500">Edition</dt>
                <dd className="text-stone-900 font-medium">
                  {artwork.editionNumber} / {artwork.totalEditions}
                </dd>
              </>
            )}
            <dt className="text-stone-500">SKU</dt>
            <dd className="text-stone-400 font-mono text-xs">{artwork.sku}</dd>
          </dl>

          {/* Notes / description */}
          {artwork.notes && (
            <>
              <hr className="border-stone-200" />
              <div>
                <h2 className="text-sm font-semibold text-stone-700 mb-2">Description</h2>
                <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-line">
                  {artwork.notes}
                </p>
              </div>
            </>
          )}

          {/* Represented artist bio */}
          {representedArtist?.bio && (
            <>
              <hr className="border-stone-200" />
              <div>
                <h2 className="text-sm font-semibold text-stone-700 mb-2">
                  About the Artist
                </h2>
                <p className="text-sm text-stone-500 italic font-medium mb-1">
                  {representedArtist.name}
                </p>
                <p className="text-sm text-stone-600 leading-relaxed">
                  {representedArtist.bio}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Back link */}
      <div className="mt-14">
        <Link
          href={base}
          className="text-sm text-stone-500 hover:text-stone-900 transition-colors underline underline-offset-4"
        >
          ← Back to Gallery
        </Link>
      </div>
    </div>
  );
}
