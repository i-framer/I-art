/**
 * Image mutation actions — setPrimaryImage and reorderImages tenant isolation.
 *
 * Both actions verify artwork ownership via a tenant-scoped artworksTable query
 * before modifying any image rows.
 *
 * Covers:
 *  - setPrimaryImage throws "Artwork not found" when artwork belongs to another tenant
 *  - setPrimaryImage succeeds and clears other primary flags for the correct tenant
 *  - reorderImages throws "Artwork not found" when artwork belongs to another tenant
 *  - reorderImages succeeds and sets sortOrder for each image
 *  - Both actions throw for unauthenticated callers
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
// Controls whether artworksTable.findFirst returns an artwork (ownership gate)
let artworkRow: Record<string, unknown> | null = null;
const dbUpdateSets: Record<string, unknown>[] = [];
const dbUpdateWheres: unknown[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: {
        findFirst: vi.fn(async () => artworkRow),
      },
      artworkImagesTable: {
        findMany: vi.fn(async () => [
          { id: "img-1", artworkId: "art-1", isPrimary: false, sortOrder: 0, objectPath: "p/1.jpg", createdAt: new Date() },
          { id: "img-2", artworkId: "art-1", isPrimary: false, sortOrder: 1, objectPath: "p/2.jpg", createdAt: new Date() },
        ]),
      },
    },
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        dbUpdateSets.push(vals);
        return {
          where: (where: unknown) => {
            dbUpdateWheres.push(where);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
  },
  artworksTable: { id: "artworks.id", tenantId: "artworks.tenantId" },
  artworkImagesTable: {
    id: "images.id",
    artworkId: "images.artworkId",
    isPrimary: "images.isPrimary",
    sortOrder: "images.sortOrder",
    tenantId: "images.tenantId",
    objectPath: "images.objectPath",
    createdAt: "images.createdAt",
  },
  artworkCategoriesTable: {},
  representedArtistsTable: {},
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ op: "and", args })),
  asc: vi.fn((col) => ({ op: "asc", col })),
}));

// ── Object storage mock ────────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  getObjectUrl: vi.fn().mockResolvedValue("https://storage.test/img.jpg"),
  listObjects: vi.fn().mockResolvedValue([]),
}));

// ── next/cache / navigation mocks ─────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));

import { setPrimaryImage, reorderImages } from "@/app/(admin)/(gated)/catalog/actions";

beforeEach(() => {
  vi.clearAllMocks();
  artworkRow = null;
  dbUpdateSets.length = 0;
  dbUpdateWheres.length = 0;
  getSession.mockResolvedValue({ userId: "u-1", tenantId: "tenant-A", role: "owner" });
});

// ── setPrimaryImage ───────────────────────────────────────────────────────────

describe("setPrimaryImage", () => {
  it("throws 'Not authenticated' for unauthenticated callers", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    await expect(setPrimaryImage("img-1", "art-1")).rejects.toThrow("Not authenticated");
  });

  it("throws 'Artwork not found' when artwork belongs to another tenant", async () => {
    artworkRow = null; // tenant-scoped query returns nothing
    await expect(setPrimaryImage("img-1", "art-1")).rejects.toThrow("Artwork not found");
  });

  it("clears all primary flags then sets the new primary when artwork is found", async () => {
    artworkRow = { id: "art-1", tenantId: "tenant-A" };

    await setPrimaryImage("img-2", "art-1");

    // First update clears all primary flags
    expect(dbUpdateSets[0]).toMatchObject({ isPrimary: false });
    // Second update sets the new primary
    expect(dbUpdateSets[1]).toMatchObject({ isPrimary: true });
  });

  it("does NOT modify images when artwork ownership check fails", async () => {
    artworkRow = null; // access denied
    await expect(setPrimaryImage("img-1", "art-1")).rejects.toThrow();
    expect(dbUpdateSets).toHaveLength(0);
  });
});

// ── reorderImages ─────────────────────────────────────────────────────────────

describe("reorderImages", () => {
  it("throws 'Not authenticated' for unauthenticated callers", async () => {
    getSession.mockResolvedValueOnce({ userId: null, tenantId: "" });
    await expect(reorderImages("art-1", ["img-1", "img-2"])).rejects.toThrow("Not authenticated");
  });

  it("throws 'Artwork not found' when artwork belongs to another tenant", async () => {
    artworkRow = null;
    await expect(reorderImages("art-1", ["img-1", "img-2"])).rejects.toThrow("Artwork not found");
  });

  it("sets sortOrder for each image ID when artwork is owned by session tenant", async () => {
    artworkRow = { id: "art-1", tenantId: "tenant-A" };

    await reorderImages("art-1", ["img-2", "img-1"]);

    // Two UPDATE calls, one per image
    expect(dbUpdateSets.length).toBeGreaterThanOrEqual(2);
    expect(dbUpdateSets.some((s) => s.sortOrder === 0)).toBe(true);
    expect(dbUpdateSets.some((s) => s.sortOrder === 1)).toBe(true);
  });

  it("does NOT modify images when artwork ownership check fails", async () => {
    artworkRow = null;
    await expect(reorderImages("art-1", ["img-1"])).rejects.toThrow();
    expect(dbUpdateSets).toHaveLength(0);
  });
});
