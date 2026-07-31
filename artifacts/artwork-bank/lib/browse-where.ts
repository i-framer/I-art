/**
 * Builds the Drizzle WHERE clause for the public /browse query.
 *
 * Extracted from app/browse/page.tsx so it can be unit-tested without JSX.
 */
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  tenantsTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, or, eq, inArray, ilike, exists, sql } from "drizzle-orm";

export type BrowseSearchParams = {
  q?: string;
  sellerType?: string;
  seller?: string;
  artist?: string;
  category?: string;
  location?: string;
  page?: string;
};

/** Status values that are visible on the public browse page. HIDDEN is excluded. */
export const BROWSE_VISIBLE_STATUSES = ["AVAILABLE", "SOLD", "RESERVED"] as const;

/**
 * Returns the combined AND condition for the public browse query.
 * Always enforces:
 *   - storefrontEnabled = true
 *   - showInGallery = true
 *   - status IN (AVAILABLE, SOLD, RESERVED)   ← HIDDEN is excluded
 */
export function buildBrowseWhere(sp: BrowseSearchParams) {
  const conditions: ReturnType<typeof eq>[] = [
    eq(tenantsTable.storefrontEnabled, true),
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, [...BROWSE_VISIBLE_STATUSES]),
  ];

  // Keyword: title, represented artist name, or seller business name
  if (sp.q?.trim()) {
    const pattern = `%${sp.q.trim()}%`;
    conditions.push(
      or(
        ilike(artworksTable.title, pattern),
        ilike(representedArtistsTable.name, pattern),
        ilike(tenantsTable.businessName, pattern),
      )! as any,
    );
  }

  // Seller type (only ARTIST and FRAMER are accepted; others are ignored)
  if (sp.sellerType === "ARTIST" || sp.sellerType === "FRAMER") {
    conditions.push(eq(tenantsTable.type, sp.sellerType) as any);
  }

  // Specific seller by slug
  if (sp.seller) {
    conditions.push(eq(tenantsTable.slug, sp.seller) as any);
  }

  // Artist: by represented-artist name, or by tenant when the tenant is an artist
  if (sp.artist) {
    conditions.push(
      or(
        eq(representedArtistsTable.name, sp.artist),
        and(
          eq(tenantsTable.type, "ARTIST"),
          eq(tenantsTable.businessName, sp.artist),
        ),
      )! as any,
    );
  }

  // Category (matched by name via an EXISTS subquery)
  if (sp.category) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(artworkCategoryOnArtworkTable)
          .innerJoin(
            artworkCategoriesTable,
            eq(artworkCategoriesTable.id, artworkCategoryOnArtworkTable.categoryId),
          )
          .where(
            and(
              eq(artworkCategoryOnArtworkTable.artworkId, artworksTable.id),
              eq(artworkCategoriesTable.name, sp.category),
            ),
          ),
      ) as any,
    );
  }

  // Location (tenant-level)
  if (sp.location) {
    conditions.push(eq(tenantsTable.location, sp.location) as any);
  }

  return and(...conditions);
}
