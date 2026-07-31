/**
 * WHERE-condition builders for the /browse filter-option dropdown queries.
 *
 * Extracted from app/browse/page.tsx so they can be unit-tested without JSX
 * or a real database connection (mirrors the pattern used by browse-where.ts).
 *
 * Each exported function returns a Drizzle SQL condition that can be passed
 * directly to a `.where()` call.
 */
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
  tenantsTable,
  representedArtistsTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, exists, sql } from "drizzle-orm";
import { BROWSE_VISIBLE_STATUSES } from "./browse-where";

// ── Shared base conditions ────────────────────────────────────────────────────

/** Tenants must have an active storefront. */
export const ENABLED_STOREFRONT = eq(tenantsTable.storefrontEnabled, true);

/** Artworks must be visible: showInGallery=true AND status is not HIDDEN. */
function artworkVisibleConditions() {
  return [
    eq(artworksTable.showInGallery, true),
    inArray(artworksTable.status, [...BROWSE_VISIBLE_STATUSES]),
  ] as const;
}

// ── Seller (tenant) filter options ────────────────────────────────────────────

/**
 * WHERE condition for the sellers dropdown.
 *
 * Only tenants with storefrontEnabled=true that have at least one visible
 * artwork (showInGallery=true, status IN (AVAILABLE, SOLD, RESERVED)) are
 * included.  Showing a seller whose every artwork is hidden would result in
 * an empty browse grid when the buyer selects that filter — a confusing UX.
 * This mirrors the same EXISTS guard used by artistTenantFilterWhere() and
 * categoryFilterWhere().
 */
export function sellerFilterWhere() {
  return and(
    ENABLED_STOREFRONT,
    exists(
      db
        .select({ one: sql`1` })
        .from(artworksTable)
        .where(
          and(
            eq(artworksTable.tenantId, tenantsTable.id),
            ...artworkVisibleConditions(),
          ),
        ),
    ),
  );
}

// ── Location filter options ───────────────────────────────────────────────────

/**
 * WHERE condition for the location dropdown.
 * Only tenants with storefrontEnabled=true and a non-null location.
 */
export function locationFilterWhere() {
  return and(ENABLED_STOREFRONT, isNotNull(tenantsTable.location));
}

// ── Artist filter options ─────────────────────────────────────────────────────

/**
 * WHERE condition for the represented-artist dropdown query.
 *
 * Restricts to:
 *   - storefrontEnabled tenants, AND
 *   - the artist must have at least one visible artwork (showInGallery=true,
 *     status IN (AVAILABLE, SOLD, RESERVED)) so that categories from
 *     tenants with all-hidden artworks are excluded.
 */
export function representedArtistFilterWhere() {
  return and(
    ENABLED_STOREFRONT,
    exists(
      db
        .select({ one: sql`1` })
        .from(artworksTable)
        .where(
          and(
            eq(artworksTable.representedArtistId, representedArtistsTable.id),
            ...artworkVisibleConditions(),
          ),
        ),
    ),
  );
}

/**
 * WHERE condition for the ARTIST-type tenant dropdown query.
 * Only ARTIST tenants with storefrontEnabled=true that have at least one
 * visible artwork.
 */
export function artistTenantFilterWhere() {
  return and(
    ENABLED_STOREFRONT,
    eq(tenantsTable.type, "ARTIST"),
    exists(
      db
        .select({ one: sql`1` })
        .from(artworksTable)
        .where(
          and(
            eq(artworksTable.tenantId, tenantsTable.id),
            ...artworkVisibleConditions(),
          ),
        ),
    ),
  );
}

// ── Category filter options ───────────────────────────────────────────────────

/**
 * WHERE condition for the category dropdown query.
 *
 * Restricts to:
 *   - storefrontEnabled tenants, AND
 *   - at least one visible artwork is tagged with this category, so that
 *     categories from tenants with all-hidden artworks are excluded.
 */
export function categoryFilterWhere() {
  return and(
    ENABLED_STOREFRONT,
    exists(
      db
        .select({ one: sql`1` })
        .from(artworkCategoryOnArtworkTable)
        .innerJoin(
          artworksTable,
          eq(artworksTable.id, artworkCategoryOnArtworkTable.artworkId),
        )
        .where(
          and(
            eq(artworkCategoryOnArtworkTable.categoryId, artworkCategoriesTable.id),
            ...artworkVisibleConditions(),
          ),
        ),
    ),
  );
}
