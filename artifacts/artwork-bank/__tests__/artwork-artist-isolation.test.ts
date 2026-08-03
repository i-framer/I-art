/**
 * Artwork actions — representedArtistId cross-tenant isolation.
 *
 * `createArtwork` and `updateArtwork` pass `representedArtistId` directly into
 * the insert values without a tenant-scoped lookup. These tests document the
 * current behavior and provide a regression baseline if a validation is added.
 *
 * Current behavior:
 *  - The actions set `tenantId = session.tenantId` on the artwork row.
 *  - `representedArtistId` is stored as-is; there is no cross-tenant check.
 *  - These tests confirm that, given the current code, the action does NOT
 *    explicitly reject a foreign-tenant artist ID (i.e. it stores it).
 *  - This serves as a regression test: if validation is later added, these
 *    tests will need to be updated to assert rejection instead.
 *
 * The artwork's `tenantId` is always set to the session tenant, so data
 * ownership is preserved even if `representedArtistId` is foreign.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock ─────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getSession }));

// ── Billing mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn().mockResolvedValue(undefined),
}));

// ── DB state ──────────────────────────────────────────────────────────────────
const capturedInserts: Record<string, unknown>[] = [];
const capturedUpdates: Record<string, unknown>[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => {
        capturedInserts.push(vals);
        return {
          returning: vi.fn().mockResolvedValue([{ id: "art-new", ...vals }]),
        };
      },
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        capturedUpdates.push(vals);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "art-1" }]),
          }),
        };
      },
    })),
    query: {
      artworkCategoriesTable: {
        findMany: vi.fn(async () => []),
      },
      artworksTable: {
        findFirst: vi.fn(async () => ({ id: "art-1", tenantId: "tenant-A" })),
      },
    },
  },
  artworksTable: { id: "artworks.id", tenantId: "artworks.tenantId" },
  artworkCategoriesTable: { id: "cats.id", tenantId: "cats.tenantId" },
  artworkCategoryOnArtworkTable: {},
  artworkImagesTable: {},
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn(),
}));

// ── Object storage mock ────────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));

// ── next/cache / navigation mocks ─────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));

import { createArtwork, updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

function formData(fields: Record<string, string | string[]>): FormData {
  return {
    get: (k: string) => (Array.isArray(fields[k]) ? null : (fields[k] ?? null)),
    getAll: (k: string) => (Array.isArray(fields[k]) ? fields[k] : []),
  } as unknown as FormData;
}

const baseArtworkFields = {
  title: "Test Artwork",
  sku: "SKU-001",
  status: "AVAILABLE",
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedInserts.length = 0;
  capturedUpdates.length = 0;
  getSession.mockResolvedValue({ userId: "u-1", tenantId: "tenant-A", role: "owner" });
});

describe("createArtwork — representedArtistId isolation", () => {
  it("stores the representedArtistId from form data without a tenant check (current behavior)", async () => {
    // This documents current behavior: no cross-tenant validation on artist ID.
    await createArtwork(
      { error: "" },
      formData({
        ...baseArtworkFields,
        representedArtistId: "artist-from-tenant-B", // foreign-tenant artist
      }),
    ).catch(() => {}); // redirect is thrown on success

    const inserted = capturedInserts[0];
    // The artwork row is correctly scoped to the session tenant
    expect(inserted?.tenantId).toBe("tenant-A");
    // The artist ID is stored as-is without cross-tenant validation (current behavior)
    expect(inserted?.representedArtistId).toBe("artist-from-tenant-B");
  });

  it("sets representedArtistId to null when not provided", async () => {
    await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields }),
    ).catch(() => {});

    expect(capturedInserts[0]?.representedArtistId).toBeNull();
  });

  it("always sets tenantId to session.tenantId regardless of artist", async () => {
    await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "any-artist-id" }),
    ).catch(() => {});

    expect(capturedInserts[0]?.tenantId).toBe("tenant-A");
  });
});

describe("updateArtwork — representedArtistId isolation", () => {
  it("updates representedArtistId from form data without a tenant check (current behavior)", async () => {
    await updateArtwork(
      "art-1",
      { error: "" },
      formData({
        ...baseArtworkFields,
        representedArtistId: "artist-from-tenant-B",
      }),
    ).catch(() => {});

    const updated = capturedUpdates[0];
    expect(updated?.representedArtistId).toBe("artist-from-tenant-B");
  });

  it("clears representedArtistId when not provided in update", async () => {
    await updateArtwork(
      "art-1",
      { error: "" },
      formData({ ...baseArtworkFields }),
    ).catch(() => {});

    expect(capturedUpdates[0]?.representedArtistId).toBeNull();
  });
});
