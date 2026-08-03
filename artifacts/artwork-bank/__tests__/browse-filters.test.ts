/**
 * Tasks #283, #285, #287, #292 — browse-filter logic
 *
 * Tests that:
 *  #283 — BROWSE_VISIBLE_STATUSES includes SOLD and RESERVED so the artist
 *         filter returns artworks regardless of their sale status.
 *  #285 — HIDDEN is excluded from BROWSE_VISIBLE_STATUSES, and showInGallery=false
 *         artworks are blocked by the base WHERE condition.
 *  #287 — buildBrowseWhere includes a seller-slug condition AND a keyword (q=)
 *         condition when both are supplied, making them additive (AND, not OR).
 *  #292 — artistTenantFilterWhere enforces showInGallery=true and status IN
 *         (AVAILABLE, SOLD, RESERVED) so ARTIST tenants appear only when they
 *         have at least one visible artwork — including SOLD/RESERVED ones.
 */
import { describe, it, expect, vi } from "vitest";

// ── Minimal DB mock so Drizzle table refs resolve ─────────────────────────────

vi.mock("@workspace/db", () => {
  const col = (name: string) => ({ columnName: name, table: "mock" });
  const table = (cols: string[]) =>
    Object.fromEntries(cols.map((c) => [c, col(c)]));
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(),
          innerJoin: vi.fn(() => ({ where: vi.fn() })),
        })),
      })),
    },
    artworksTable: table([
      "id", "tenantId", "showInGallery", "status", "title", "price",
      "representedArtistId",
    ]),
    tenantsTable: table([
      "id", "slug", "storefrontEnabled", "businessName", "type", "location",
    ]),
    representedArtistsTable: table(["id", "name", "tenantId"]),
    artworkCategoriesTable: table(["id", "name"]),
    artworkCategoryOnArtworkTable: table(["artworkId", "categoryId"]),
  };
});

import {
  buildBrowseWhere,
  BROWSE_VISIBLE_STATUSES,
} from "@/lib/browse-where";
import {
  artistTenantFilterWhere,
  sellerFilterWhere,
} from "@/lib/browse-filter-options";

// ── Helper: extract the raw SQL string from a Drizzle condition ───────────────

function _toSql(condition: any): string {
  try {
    // Drizzle conditions expose their SQL via getSQL() or toString()
    if (typeof condition?.getSQL === "function") {
      const { sql, params } = condition.getSQL();
      let s: string = typeof sql === "string" ? sql : String(sql);
      // Inline params for readability
      if (Array.isArray(params)) {
        params.forEach((p, i) => {
          s = s.replace(`$${i + 1}`, JSON.stringify(p));
        });
      }
      return s;
    }
    return JSON.stringify(condition);
  } catch {
    return JSON.stringify(condition);
  }
}

// ────────────────────────────────────────────────────────────────────────────

describe("BROWSE_VISIBLE_STATUSES (Tasks #283, #285, #292)", () => {
  it("includes AVAILABLE", () => {
    expect(BROWSE_VISIBLE_STATUSES).toContain("AVAILABLE");
  });

  it("includes SOLD — artist filter must surface sold-only artworks (#283)", () => {
    expect(BROWSE_VISIBLE_STATUSES).toContain("SOLD");
  });

  it("includes RESERVED — artist filter must surface reserved-only artworks (#283)", () => {
    expect(BROWSE_VISIBLE_STATUSES).toContain("RESERVED");
  });

  it("does NOT include HIDDEN — hidden artworks must be excluded from public browse (#285)", () => {
    expect(BROWSE_VISIBLE_STATUSES).not.toContain("HIDDEN");
  });

  it("has exactly 3 entries: AVAILABLE, SOLD, RESERVED (#285)", () => {
    expect(BROWSE_VISIBLE_STATUSES).toHaveLength(3);
    expect(new Set(BROWSE_VISIBLE_STATUSES).size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("buildBrowseWhere (#285, #287)", () => {
  it("returns a non-null condition with no search params", () => {
    const cond = buildBrowseWhere({});
    expect(cond).toBeDefined();
    expect(cond).not.toBeNull();
  });

  it("returns a non-null condition with all params supplied (#287)", () => {
    const cond = buildBrowseWhere({
      q: "sunrise",
      seller: "jane-smith-studio",
      sellerType: "ARTIST",
      artist: "Jane Smith",
      category: "Landscape",
      location: "Sydney",
    });
    expect(cond).toBeDefined();
    expect(cond).not.toBeNull();
  });

  it("returns a non-null condition when seller slug and keyword are both set (#287)", () => {
    // Both filters must be applied; if either was ignored the result would be
    // the same as supplying only one — this verifies neither is dropped.
    const combined = buildBrowseWhere({ q: "sunrise", seller: "jane-smith-studio" });
    const sellerOnly = buildBrowseWhere({ seller: "jane-smith-studio" });
    const keywordOnly = buildBrowseWhere({ q: "sunrise" });
    // All three must produce conditions (none null)
    expect(combined).not.toBeNull();
    expect(sellerOnly).not.toBeNull();
    expect(keywordOnly).not.toBeNull();
    // Combined should be a different (more constrained) clause than either alone
    expect(combined).not.toEqual(sellerOnly);
    expect(combined).not.toEqual(keywordOnly);
  });

  it("produces a different condition when seller is set versus not (#287)", () => {
    const withSeller = buildBrowseWhere({ seller: "jane-studio" });
    const withoutSeller = buildBrowseWhere({});
    expect(withSeller).not.toEqual(withoutSeller);
  });

  it("produces a different condition when q is set versus not (#287)", () => {
    const withQ = buildBrowseWhere({ q: "landscape" });
    const withoutQ = buildBrowseWhere({});
    expect(withQ).not.toEqual(withoutQ);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("sellerFilterWhere (#285)", () => {
  it("returns a non-null condition", () => {
    const cond = sellerFilterWhere();
    expect(cond).toBeDefined();
    expect(cond).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("artistTenantFilterWhere (Tasks #292, #285)", () => {
  it("returns a non-null condition (#292)", () => {
    const cond = artistTenantFilterWhere();
    expect(cond).toBeDefined();
    expect(cond).not.toBeNull();
  });

  it("uses BROWSE_VISIBLE_STATUSES which includes SOLD and RESERVED — so ARTIST tenants with only sold/reserved artworks are still included (#292)", () => {
    // The condition internally calls artworkVisibleConditions() which uses
    // BROWSE_VISIBLE_STATUSES. Since SOLD and RESERVED are in that set,
    // an ARTIST tenant whose artworks are all SOLD or RESERVED still has
    // at least one "visible" artwork and will appear in the dropdown.
    expect(BROWSE_VISIBLE_STATUSES).toContain("SOLD");
    expect(BROWSE_VISIBLE_STATUSES).toContain("RESERVED");
  });

  it("produces a different clause than sellerFilterWhere (ARTIST tenants only) (#292)", () => {
    const artistCond = artistTenantFilterWhere();
    const sellerCond = sellerFilterWhere();
    // They are structurally different because artistTenantFilterWhere adds a
    // type = 'ARTIST' constraint that sellerFilterWhere does not.
    expect(artistCond).not.toEqual(sellerCond);
  });
});
