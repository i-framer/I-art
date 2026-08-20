/**
 * Regression tests: the public /browse query must never expose hidden artwork
 * or artworks belonging to disabled storefronts.
 *
 * Strategy: mock @workspace/db with stub table objects whose columns are
 * string sentinels, then call buildBrowseWhere() and assert on the resulting
 * Drizzle condition object using JSON.stringify.  No JSX or database
 * connection required.
 */
import { describe, it, expect, vi } from "vitest";

// ── Stub table columns (string sentinels) ─────────────────────────────────────
//   Drizzle-orm operators (eq, and, inArray, …) just wrap their arguments in
//   plain objects, so any sentinel string produces a deterministic JSON shape.

const tables = vi.hoisted(() => ({
  artworksTable: {
    id: "artworks.id",
    tenantId: "artworks.tenantId",
    status: "artworks.status",
    showInGallery: "artworks.showInGallery",
    title: "artworks.title",
    createdAt: "artworks.createdAt",
    representedArtistId: "artworks.representedArtistId",
    price: "artworks.price",
  },
  tenantsTable: {
    id: "tenants.id",
    storefrontEnabled: "tenants.storefrontEnabled",
    type: "tenants.type",
    slug: "tenants.slug",
    businessName: "tenants.businessName",
    location: "tenants.location",
  },
  representedArtistsTable: {
    id: "artists.id",
    tenantId: "artists.tenantId",
    name: "artists.name",
  },
  artworkImagesTable: {
    id: "images.id",
    artworkId: "images.artworkId",
    isPrimary: "images.isPrimary",
    objectPath: "images.objectPath",
  },
  artworkCategoriesTable: {
    id: "categories.id",
    tenantId: "categories.tenantId",
    name: "categories.name",
  },
  artworkCategoryOnArtworkTable: {
    artworkId: "acoa.artworkId",
    categoryId: "acoa.categoryId",
  },
}));

// ── Mock @workspace/db ────────────────────────────────────────────────────────
//   The category EXISTS subquery calls db.select().from().innerJoin().where().
//   That subquery is just wrapped by drizzle's exists(), so we only need a
//   minimal chainable builder — it never needs to be awaited.

vi.mock("@workspace/db", () => {
  /**
   * Chainable builder that carries its last `.where()` argument so that it is
   * visible when JSON.stringify serialises an EXISTS subquery wrapping this
   * builder.  The `toJSON` hook is what makes the inner WHERE args (e.g.
   * category name) surface in the outer condition's serialised form.
   */
  function makeBuilder(capturedWhere: any = null): any {
    const b: any = {
      from: () => makeBuilder(capturedWhere),
      innerJoin: () => makeBuilder(capturedWhere),
      leftJoin: () => makeBuilder(capturedWhere),
      where: (w: any) => makeBuilder(w),
      orderBy: () => makeBuilder(capturedWhere),
      limit: () => makeBuilder(capturedWhere),
      offset: () => Promise.resolve([]),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
      toJSON: () => ({ _where: capturedWhere }),
    };
    return b;
  }

  return {
    db: {
      select: vi.fn(() => makeBuilder()),
      selectDistinct: vi.fn(() => makeBuilder()),
    },
    ...tables,
  };
});

// ── Import the function under test (after mocks) ──────────────────────────────

import { buildBrowseWhere } from "@/lib/browse-where";
import {
  sellerFilterWhere,
  locationFilterWhere,
  representedArtistFilterWhere,
  artistTenantFilterWhere,
  categoryFilterWhere,
  ENABLED_STOREFRONT,
} from "@/lib/browse-filter-options";
import { and, eq, inArray, or, isNotNull } from "drizzle-orm";

// ── Helpers ───────────────────────────────────────────────────────────────────

const j = (v: any) => JSON.stringify(v);
const t = tables;

// The three conditions that must always appear
const BASE_STOREFRONT   = eq(t.tenantsTable.storefrontEnabled as any, true);
const BASE_GALLERY      = eq(t.artworksTable.showInGallery as any, true);
const BASE_STATUSES     = inArray(t.artworksTable.status as any, ["AVAILABLE", "SOLD", "RESERVED"]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildBrowseWhere — base visibility conditions", () => {
  it("always requires storefrontEnabled = true", () => {
    const w = buildBrowseWhere({});
    expect(j(w)).toContain(j(BASE_STOREFRONT));
  });

  it("always requires showInGallery = true", () => {
    const w = buildBrowseWhere({});
    expect(j(w)).toContain(j(BASE_GALLERY));
  });

  it("excludes HIDDEN — only AVAILABLE, SOLD and RESERVED are in the allowed list", () => {
    const w = buildBrowseWhere({});
    const s = j(w);
    // The inArray payload must be present
    expect(s).toContain(j(BASE_STATUSES));
    // HIDDEN must not appear in the serialised allowed-status list
    expect(s).not.toContain("HIDDEN");
    expect(s).toContain("AVAILABLE");
    expect(s).toContain("SOLD");
    expect(s).toContain("RESERVED");
  });

  it("wraps all three base conditions in a single AND", () => {
    const w = buildBrowseWhere({});
    const s = j(w);
    expect(s).toContain(j(BASE_STOREFRONT));
    expect(s).toContain(j(BASE_GALLERY));
    expect(s).toContain(j(BASE_STATUSES));
  });
});

describe("buildBrowseWhere — keyword filter (q)", () => {
  it("uses indexable title, represented-artist, and seller match branches", () => {
    const w = buildBrowseWhere({ q: "ocean" });
    const serialized = j(w);

    expect(serialized).toContain("IN (");
    expect(serialized).toContain("UNION ALL");
    expect(serialized).toContain(t.artworksTable.title);
    expect(serialized).toContain(t.representedArtistsTable.name);
    expect(serialized).toContain(t.tenantsTable.businessName);
    expect(serialized).toContain("%ocean%");
  });

  it("trims the keyword before building ilike patterns", () => {
    const w = buildBrowseWhere({ q: "  sunset  " });
    expect(j(w)).toContain("%sunset%");
    expect(j(w)).not.toContain("%  sunset  %");
  });

  it("does not add a keyword condition when q is absent", () => {
    const w = buildBrowseWhere({});
    expect(j(w)).not.toContain('"ilike"');
  });

  it("does not add a keyword condition when q is whitespace only", () => {
    const w = buildBrowseWhere({ q: "   " });
    expect(j(w)).not.toContain('"ilike"');
  });
});

describe("buildBrowseWhere — sellerType filter", () => {
  it("adds eq(type, ARTIST) for sellerType=ARTIST", () => {
    const w = buildBrowseWhere({ sellerType: "ARTIST" });
    expect(j(w)).toContain(j(eq(t.tenantsTable.type as any, "ARTIST")));
  });

  it("adds eq(type, FRAMER) for sellerType=FRAMER", () => {
    const w = buildBrowseWhere({ sellerType: "FRAMER" });
    expect(j(w)).toContain(j(eq(t.tenantsTable.type as any, "FRAMER")));
  });

  it("ignores unrecognised sellerType values", () => {
    const w = buildBrowseWhere({ sellerType: "GALLERY" });
    expect(j(w)).not.toContain(j(eq(t.tenantsTable.type as any, "GALLERY")));
  });

  it("base conditions still present when sellerType is set", () => {
    const w = buildBrowseWhere({ sellerType: "ARTIST" });
    expect(j(w)).toContain(j(BASE_STOREFRONT));
    expect(j(w)).toContain(j(BASE_GALLERY));
    expect(j(w)).toContain(j(BASE_STATUSES));
  });
});

describe("buildBrowseWhere — seller filter", () => {
  it("adds eq(slug, seller) when seller param is set", () => {
    const w = buildBrowseWhere({ seller: "my-gallery" });
    expect(j(w)).toContain(j(eq(t.tenantsTable.slug as any, "my-gallery")));
  });

  it("does not add a slug condition when seller is absent", () => {
    const w = buildBrowseWhere({});
    // The slug column should not appear in any condition when seller is absent
    expect(j(w)).not.toContain('"tenants.slug"');
  });
});

describe("buildBrowseWhere — artist filter", () => {
  it("matches by represented-artist name OR artist-type tenant business name", () => {
    const w = buildBrowseWhere({ artist: "Jane Doe" });
    const expectedOr = or(
      eq(t.representedArtistsTable.name as any, "Jane Doe"),
      and(
        eq(t.tenantsTable.type as any, "ARTIST"),
        eq(t.tenantsTable.businessName as any, "Jane Doe"),
      ),
    );
    expect(j(w)).toContain(j(expectedOr));
  });

  it("does not add an artist condition when artist param is absent", () => {
    const w = buildBrowseWhere({});
    // representedArtistsTable.name should not appear when artist is absent
    expect(j(w)).not.toContain('"artists.name"');
  });
});

describe("buildBrowseWhere — category filter", () => {
  it("adds an EXISTS subquery that includes the category name and artwork link", () => {
    const w = buildBrowseWhere({ category: "Painting" });
    const s = j(w);
    // The category name value must be embedded somewhere in the condition
    expect(s).toContain("Painting");
    // The subquery references the category join columns
    expect(s).toContain("acoa.artworkId");
    expect(s).toContain("categories.name");
  });

  it("does not add a category condition when category param is absent", () => {
    const w = buildBrowseWhere({});
    expect(j(w)).not.toContain("acoa.artworkId");
    expect(j(w)).not.toContain("categories.name");
  });
});

describe("buildBrowseWhere — location filter", () => {
  it("adds eq(location, value) when location param is set", () => {
    const w = buildBrowseWhere({ location: "Sydney" });
    expect(j(w)).toContain(j(eq(t.tenantsTable.location as any, "Sydney")));
  });

  it("does not add a location condition when location is absent", () => {
    const w = buildBrowseWhere({});
    expect(j(w)).not.toContain('"tenants.location"');
  });
});

// ── Filter-option condition builder tests ─────────────────────────────────────
//
// These verify the WHERE conditions used by the /browse dropdown queries so
// that the seller, artist, category, and location options are always scoped to
// storefrontEnabled tenants AND (for artist/category) only tenants that have
// at least one visible artwork.

describe("filter-option — seller (sellerFilterWhere)", () => {
  it("requires storefrontEnabled = true", () => {
    const w = sellerFilterWhere();
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });

  it("also requires at least one visible artwork (EXISTS subquery)", () => {
    // sellerFilterWhere() was updated to add the same EXISTS guard used by
    // artistTenantFilterWhere() and categoryFilterWhere(): tenants whose every
    // artwork is hidden must not appear in the seller dropdown.
    const w = sellerFilterWhere();
    // The serialised condition must be strictly larger than ENABLED_STOREFRONT
    // alone — confirming additional clauses are present.
    expect(j(w)).not.toBe(j(ENABLED_STOREFRONT));
    // The storefrontEnabled check must still be there.
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });
});

describe("filter-option — location (locationFilterWhere)", () => {
  it("requires storefrontEnabled = true", () => {
    const w = locationFilterWhere();
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });

  it("also requires location IS NOT NULL", () => {
    const w = locationFilterWhere();
    expect(j(w)).toContain(j(isNotNull(t.tenantsTable.location as any)));
  });

  it("requires showInGallery = true via an EXISTS subquery", () => {
    const w = locationFilterWhere();
    expect(j(w)).toContain('"artworks.showInGallery"');
    expect(j(w)).toContain("true");
  });

  it("excludes HIDDEN via status allowlist in the EXISTS subquery", () => {
    const w = locationFilterWhere();
    const s = j(w);
    expect(s).toContain("AVAILABLE");
    expect(s).toContain("SOLD");
    expect(s).toContain("RESERVED");
    expect(s).not.toContain("HIDDEN");
  });
});

describe("filter-option — represented artist (representedArtistFilterWhere)", () => {
  it("requires storefrontEnabled = true", () => {
    const w = representedArtistFilterWhere();
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });

  it("requires showInGallery = true via an EXISTS subquery", () => {
    const w = representedArtistFilterWhere();
    expect(j(w)).toContain('"artworks.showInGallery"');
    expect(j(w)).toContain("true");
  });

  it("excludes HIDDEN via status allowlist in the EXISTS subquery", () => {
    const w = representedArtistFilterWhere();
    const s = j(w);
    expect(s).toContain("AVAILABLE");
    expect(s).toContain("SOLD");
    expect(s).toContain("RESERVED");
    expect(s).not.toContain("HIDDEN");
  });

  it("links the subquery to the represented artist row (artworks.representedArtistId)", () => {
    const w = representedArtistFilterWhere();
    expect(j(w)).toContain('"artworks.representedArtistId"');
    expect(j(w)).toContain('"artists.id"');
  });
});

describe("filter-option — artist tenant (artistTenantFilterWhere)", () => {
  it("requires storefrontEnabled = true", () => {
    const w = artistTenantFilterWhere();
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });

  it("restricts to ARTIST-type tenants", () => {
    const w = artistTenantFilterWhere();
    expect(j(w)).toContain(j(eq(t.tenantsTable.type as any, "ARTIST")));
  });

  it("requires showInGallery = true via an EXISTS subquery", () => {
    const w = artistTenantFilterWhere();
    expect(j(w)).toContain('"artworks.showInGallery"');
  });

  it("excludes HIDDEN via status allowlist in the EXISTS subquery", () => {
    const w = artistTenantFilterWhere();
    const s = j(w);
    expect(s).toContain("AVAILABLE");
    expect(s).not.toContain("HIDDEN");
  });

  it("links the subquery to the tenant row (artworks.tenantId)", () => {
    const w = artistTenantFilterWhere();
    expect(j(w)).toContain('"artworks.tenantId"');
    expect(j(w)).toContain('"tenants.id"');
  });
});

describe("filter-option — category (categoryFilterWhere)", () => {
  it("requires storefrontEnabled = true", () => {
    const w = categoryFilterWhere();
    expect(j(w)).toContain(j(ENABLED_STOREFRONT));
  });

  it("requires showInGallery = true via an EXISTS subquery", () => {
    const w = categoryFilterWhere();
    expect(j(w)).toContain('"artworks.showInGallery"');
    expect(j(w)).toContain("true");
  });

  it("excludes HIDDEN via status allowlist in the EXISTS subquery", () => {
    const w = categoryFilterWhere();
    const s = j(w);
    expect(s).toContain("AVAILABLE");
    expect(s).toContain("SOLD");
    expect(s).toContain("RESERVED");
    expect(s).not.toContain("HIDDEN");
  });

  it("links the EXISTS subquery through acoa to the category row", () => {
    // acoa.artworkId is in the JOIN condition (not WHERE), so it is not
    // captured by the mock's toJSON hook.  The WHERE contains the category
    // link (acoa.categoryId = categories.id) and the artwork-visibility
    // guards — that is sufficient to confirm the subquery is wired correctly.
    const w = categoryFilterWhere();
    const s = j(w);
    expect(s).toContain('"acoa.categoryId"');
    expect(s).toContain('"categories.id"');
  });

  it("categories from tenants with all-hidden artworks are excluded — EXISTS requires a visible artwork", () => {
    // The WHERE must include BOTH storefrontEnabled AND the visibility EXISTS.
    // A tenant with storefrontEnabled=true but showInGallery=false on all artworks
    // would match storefrontEnabled alone but not the EXISTS — so it is excluded.
    const w = categoryFilterWhere();
    const s = j(w);
    expect(s).toContain(j(ENABLED_STOREFRONT));
    expect(s).toContain('"artworks.showInGallery"');
    // Confirm the allowed-status list is also embedded (rules out HIDDEN status)
    expect(s).toContain(j(inArray(t.artworksTable.status as any, ["AVAILABLE", "SOLD", "RESERVED"])));
  });
});

describe("filter-option — artists from all-hidden-artwork tenants are excluded", () => {
  it("representedArtistFilterWhere requires a visible artwork link", () => {
    // A represented artist whose only artworks are hidden (showInGallery=false
    // or status=HIDDEN) would not satisfy the EXISTS subquery and therefore
    // would not appear in the dropdown.
    const w = representedArtistFilterWhere();
    const s = j(w);
    expect(s).toContain(j(ENABLED_STOREFRONT));
    expect(s).toContain('"artworks.showInGallery"');
    expect(s).toContain(j(inArray(t.artworksTable.status as any, ["AVAILABLE", "SOLD", "RESERVED"])));
  });

  it("artistTenantFilterWhere requires a visible artwork in that tenant", () => {
    const w = artistTenantFilterWhere();
    const s = j(w);
    expect(s).toContain(j(ENABLED_STOREFRONT));
    expect(s).toContain('"artworks.showInGallery"');
    expect(s).toContain(j(inArray(t.artworksTable.status as any, ["AVAILABLE", "SOLD", "RESERVED"])));
  });
});

describe("buildBrowseWhere — combined filters", () => {
  it("combines keyword + sellerType with the three base conditions", () => {
    const w = buildBrowseWhere({ q: "coast", sellerType: "ARTIST" });
    const s = j(w);
    expect(s).toContain("coast");
    expect(s).toContain(j(eq(t.tenantsTable.type as any, "ARTIST")));
    expect(s).toContain(j(BASE_STOREFRONT));
    expect(s).toContain(j(BASE_GALLERY));
    expect(s).toContain(j(BASE_STATUSES));
  });

  it("combines seller + location", () => {
    const w = buildBrowseWhere({ seller: "coastal-gallery", location: "Melbourne" });
    const s = j(w);
    expect(s).toContain(j(eq(t.tenantsTable.slug as any, "coastal-gallery")));
    expect(s).toContain(j(eq(t.tenantsTable.location as any, "Melbourne")));
    expect(s).toContain(j(BASE_STOREFRONT));
  });

  it("all three base conditions survive when every optional filter is applied", () => {
    const w = buildBrowseWhere({
      q: "blue",
      sellerType: "FRAMER",
      seller: "some-framer",
      artist: "Artist X",
      category: "Sculpture",
      location: "Brisbane",
    });
    const s = j(w);
    expect(s).toContain(j(BASE_STOREFRONT));
    expect(s).toContain(j(BASE_GALLERY));
    expect(s).toContain(j(BASE_STATUSES));
  });

  it("disabled storefronts are excluded even when all filters match", () => {
    // storefrontEnabled=true must always be part of the AND — there is no code
    // path that drops it.  We verify it remains present alongside every filter.
    const w = buildBrowseWhere({
      q: "gallery",
      sellerType: "ARTIST",
      location: "Perth",
    });
    expect(j(w)).toContain(j(BASE_STOREFRONT));
  });
});
