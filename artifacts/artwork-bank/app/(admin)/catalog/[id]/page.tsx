import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
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
import { and, eq } from "drizzle-orm";
import { ArtworkForm } from "../_form";
import { ChevronRight } from "lucide-react";

export const metadata: Metadata = { title: "Edit Artwork" };

export default async function EditArtworkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; created?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { id } = await params;
  const sp = await searchParams;

  const [artwork, tenant] = await Promise.all([
    db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, id),
        eq(artworksTable.tenantId, session.tenantId),
      ),
    }),
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
  ]);

  if (!artwork || !tenant) notFound();

  const [images, categories, catAssignments, artists] = await Promise.all([
    db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.artworkId, id),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
    }),
    db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    db.query.artworkCategoryOnArtworkTable.findMany({
      where: eq(artworkCategoryOnArtworkTable.artworkId, id),
    }),
    db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
  ]);

  const selectedCategoryIds = catAssignments.map((a) => a.categoryId);

  return (
    <div className="px-8 py-8 max-w-2xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-stone-500 mb-4">
        <Link href="/catalog" className="hover:text-stone-900 transition-colors">
          Catalog
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-stone-900 truncate max-w-48">{artwork.title}</span>
      </nav>

      {/* Success notice */}
      {(sp.saved || sp.created) && (
        <div className="mb-5 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          {sp.created ? "Artwork created! Add images below." : "Changes saved."}
        </div>
      )}

      <div className="flex items-start justify-between mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">{artwork.title}</h1>
        <span className="text-xs text-stone-400 font-mono">{artwork.sku}</span>
      </div>

      <ArtworkForm
        artwork={artwork}
        images={images}
        categories={categories}
        selectedCategoryIds={selectedCategoryIds}
        artists={artists}
        tenantType={tenant.type}
      />
    </div>
  );
}
