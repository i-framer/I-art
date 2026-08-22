import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, artworksTable } from "@workspace/db";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { formatPrice } from "@/lib/format";
import { FreightQuoteChecker } from "../_components/freight-quote-checker";

type Props = {
  params: Promise<{ slug: string; artworkId: string }>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, artworkId } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return {};

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenant.id),
      eq(artworksTable.status, "AVAILABLE"),
      eq(artworksTable.showInGallery, true),
    ),
  });

  return artwork
    ? {
        title: `Check freight — ${artwork.title}`,
        description: `Check Australian delivery pricing for ${artwork.title} from ${tenant.businessName}.`,
      }
    : {};
}

export default async function FreightQuotePage({ params }: Props) {
  const { slug, artworkId } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenant.id),
      eq(artworksTable.status, "AVAILABLE"),
      eq(artworksTable.showInGallery, true),
    ),
  });
  if (!artwork) notFound();

  const base = `/t/${slug}`;
  const themeColor = tenant.themeColor ?? "#1c1917";

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <nav className="mb-8 flex items-center gap-2 text-sm text-stone-500">
        <Link href={base} className="transition-colors hover:text-stone-900">
          Gallery
        </Link>
        <span className="text-stone-300">/</span>
        <Link
          href={`${base}/${artwork.id}`}
          className="max-w-xs truncate transition-colors hover:text-stone-900"
        >
          {artwork.title}
        </Link>
        <span className="text-stone-300">/</span>
        <span className="text-stone-700">Freight</span>
      </nav>

      <header className="mb-8">
        <p
          className="mb-2 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: themeColor }}
        >
          Delivery estimate
        </p>
        <h1 className="text-3xl font-semibold leading-tight text-stone-900">
          Check freight for {artwork.title}
        </h1>
        <p className="mt-3 text-lg font-semibold text-stone-700">
          {artwork.price ? formatPrice(artwork.price) : "Price on request"}
        </p>
      </header>

      <FreightQuoteChecker
        artworkId={artwork.id}
        artworkTitle={artwork.title}
        artworkPrice={artwork.price}
        slug={slug}
        themeColor={themeColor}
      />
    </div>
  );
}