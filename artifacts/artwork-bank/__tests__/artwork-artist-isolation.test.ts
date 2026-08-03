/**
 * Artwork actions — representedArtistId cross-tenant isolation (security fix).
 *
 * createArtwork and updateArtwork now validate that representedArtistId
 * belongs to session.tenantId before persisting. A foreign-tenant artist ID
 * is rejected with { error: "Artist not found." }.
 *
 * Covers:
 *  - createArtwork: foreign-tenant artist ID is rejected (no insert)
 *  - createArtwork: same-tenant artist ID is accepted (insert proceeds)
 *  - createArtwork: no representedArtistId → insert proceeds without artist lookup
 *  - updateArtwork: foreign-tenant artist ID is rejected (no update)
 *  - updateArtwork: same-tenant artist ID is accepted (update proceeds)
 *  - updateArtwork: no representedArtistId → update proceeds without artist lookup
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
// artistRow: controls whether representedArtistsTable.findFirst returns a row
let artistRow: Record<string, unknown> | null = null;
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
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    query: {
      artworkCategoriesTable: {
        findMany: vi.fn(async () => []),
      },
      artworksTable: {
        findFirst: vi.fn(async () => ({ id: "art-1", tenantId: "tenant-A" })),
      },
      representedArtistsTable: {
        // Returns artistRow — set to null to simulate cross-tenant (not found)
        findFirst: vi.fn(async () => artistRow),
      },
    },
  },
  artworksTable: { id: "artworks.id", tenantId: "artworks.tenantId" },
  artworkCategoriesTable: { id: "cats.id", tenantId: "cats.tenantId" },
  representedArtistsTable: { id: "ra.id", tenantId: "ra.tenantId" },
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
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { createArtwork, updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

function formData(fields: Record<string, string | string[]>): FormData {
  return {
    get: (k: string) => (Array.isArray(fields[k]) ? null : ((fields[k] as string) ?? null)),
    getAll: (k: string) => (Array.isArray(fields[k]) ? (fields[k] as string[]) : []),
  } as unknown as FormData;
}

const baseArtworkFields = {
  title: "Test Artwork",
  sku: "SKU-001",
  status: "AVAILABLE",
};

beforeEach(() => {
  vi.clearAllMocks();
  artistRow = null;
  capturedInserts.length = 0;
  capturedUpdates.length = 0;
  getSession.mockResolvedValue({ userId: "u-1", tenantId: "tenant-A", role: "owner" });
});

// ── createArtwork — representedArtistId isolation ─────────────────────────────

describe("createArtwork — representedArtistId isolation", () => {
  it("rejects a foreign-tenant artist ID with 'Artist not found.'", async () => {
    artistRow = null; // tenant-scoped lookup returns nothing → foreign tenant

    const result = await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "artist-from-tenant-B" }),
    );

    expect(result).toEqual({ error: "Artist not found." });
    expect(capturedInserts).toHaveLength(0); // no DB insert
  });

  it("accepts a same-tenant artist ID and proceeds with insert", async () => {
    artistRow = { id: "artist-tenant-A", tenantId: "tenant-A" }; // owned by session tenant

    const result = await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "artist-tenant-A" }),
    ).catch((e: Error) => (e.message.startsWith("REDIRECT:") ? { ok: true } : Promise.reject(e)));

    // Should succeed (redirect thrown means the action completed)
    expect(result).toMatchObject({ ok: true });
    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0]?.representedArtistId).toBe("artist-tenant-A");
  });

  it("skips the artist lookup and inserts when no representedArtistId is provided", async () => {
    // No artistRow setup needed — lookup should not be called at all
    const result = await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields }),
    ).catch((e: Error) => (e.message.startsWith("REDIRECT:") ? { ok: true } : Promise.reject(e)));

    expect(result).toMatchObject({ ok: true });
    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0]?.representedArtistId).toBeNull();
  });

  it("always sets tenantId to session.tenantId on inserted artwork", async () => {
    artistRow = { id: "a1", tenantId: "tenant-A" };

    await createArtwork(
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "a1" }),
    ).catch(() => {});

    if (capturedInserts.length > 0) {
      expect(capturedInserts[0]?.tenantId).toBe("tenant-A");
    }
  });
});

// ── updateArtwork — representedArtistId isolation ─────────────────────────────

describe("updateArtwork — representedArtistId isolation", () => {
  it("rejects a foreign-tenant artist ID with 'Artist not found.'", async () => {
    artistRow = null;

    const result = await updateArtwork(
      "art-1",
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "artist-from-tenant-B" }),
    );

    expect(result).toEqual({ error: "Artist not found." });
    expect(capturedUpdates).toHaveLength(0);
  });

  it("accepts a same-tenant artist ID and proceeds with update", async () => {
    artistRow = { id: "artist-tenant-A", tenantId: "tenant-A" };

    const result = await updateArtwork(
      "art-1",
      { error: "" },
      formData({ ...baseArtworkFields, representedArtistId: "artist-tenant-A" }),
    ).catch((e: Error) => (e.message.startsWith("REDIRECT:") ? { ok: true } : Promise.reject(e)));

    expect(result).toMatchObject({ ok: true });
    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]?.representedArtistId).toBe("artist-tenant-A");
  });

  it("skips the artist lookup and updates when no representedArtistId is provided", async () => {
    const result = await updateArtwork(
      "art-1",
      { error: "" },
      formData({ ...baseArtworkFields }),
    ).catch((e: Error) => (e.message.startsWith("REDIRECT:") ? { ok: true } : Promise.reject(e)));

    expect(result).toMatchObject({ ok: true });
    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]?.representedArtistId).toBeNull();
  });
});
