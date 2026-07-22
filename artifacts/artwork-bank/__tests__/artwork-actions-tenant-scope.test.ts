/**
 * Regression tests: artwork admin actions (updateArtwork, deleteArtwork,
 * bulkUpdateStatus, image management) must scope lookups and mutations by
 * the session's tenantId so a gallery can never edit or delete another
 * gallery's artworks or images.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Billing is validated separately (billing-access.test.ts); tenant-scope tests
// run with the subscription guard stubbed out.
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  updates: [] as { table: any; vals: any; where: any }[],
  deletes: [] as { table: any; where: any }[],
  inserts: [] as { table: any; vals: any }[],
  artworkFindWhere: null as any,
}));

const tables = vi.hoisted(() => ({
  artworksTable: {
    id: "artworks.id",
    tenantId: "artworks.tenantId",
    status: "artworks.status",
  },
  artworkCategoryOnArtworkTable: { artworkId: "acoa.artworkId" },
  artworkImagesTable: {
    id: "images.id",
    tenantId: "images.tenantId",
    artworkId: "images.artworkId",
    sortOrder: "images.sortOrder",
    createdAt: "images.createdAt",
  },
  artworkCategoriesTable: { id: "categories.id", tenantId: "categories.tenantId" },
}));

const artworkFindFirst = vi.hoisted(() => vi.fn());
const imageFindFirst = vi.hoisted(() => vi.fn());
const imagesFindMany = vi.hoisted(() => vi.fn());
const categoriesFindMany = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: {
        findFirst: (opts: any) => {
          state.artworkFindWhere = opts?.where;
          return artworkFindFirst(opts);
        },
      },
      artworkImagesTable: {
        findFirst: (opts: any) => imageFindFirst(opts),
        findMany: (opts: any) => imagesFindMany(opts),
      },
      artworkCategoriesTable: { findMany: (opts: any) => categoriesFindMany(opts) },
    },
    insert: vi.fn((table: any) => ({
      values: (vals: any) => {
        state.inserts.push({ table, vals });
        return {
          returning: () => Promise.resolve([{ id: "art-new", ...vals }]),
          then: (res: any) => Promise.resolve(undefined).then(res),
        };
      },
    })),
    update: vi.fn((table: any) => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ table, vals, where });
          return Promise.resolve();
        },
      }),
    })),
    delete: vi.fn((table: any) => ({
      where: (where: any) => {
        state.deletes.push({ table, where });
        return Promise.resolve();
      },
    })),
  },
  ...tables,
}));

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ userId: "user-1", tenantId: "tenant-A" })),
);
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import {
  updateArtwork,
  deleteArtwork,
  bulkUpdateStatus,
  addArtworkImage,
  deleteArtworkImage,
  setPrimaryImage,
  reorderImages,
} from "@/app/(admin)/(gated)/catalog/actions";
import { and, eq, inArray } from "drizzle-orm";

const noError = { error: "" };

function validArtworkForm() {
  const fd = new FormData();
  fd.set("title", "Sunset");
  fd.set("sku", "SKU-1");
  fd.set("status", "AVAILABLE");
  return fd;
}

const artworkA = { id: "art-1", tenantId: "tenant-A", title: "Sunset" };
const imageA = {
  id: "img-1",
  tenantId: "tenant-A",
  artworkId: "art-1",
  isPrimary: false,
};

const artworkScopedWhere = (id: string, tenantId: string) =>
  and(
    eq(tables.artworksTable.id as any, id),
    eq(tables.artworksTable.tenantId as any, tenantId),
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.deletes.length = 0;
  state.inserts.length = 0;
  state.artworkFindWhere = null;
  getSession.mockResolvedValue({ userId: "user-1", tenantId: "tenant-A" });
  // Simulate real tenant scoping: only return the artwork/image when the
  // where clause is scoped to tenant-A and the right id.
  artworkFindFirst.mockImplementation(async (opts: any) =>
    JSON.stringify(opts?.where) ===
    JSON.stringify(artworkScopedWhere("art-1", "tenant-A"))
      ? artworkA
      : undefined,
  );
  imageFindFirst.mockImplementation(async (opts: any) =>
    JSON.stringify(opts?.where) ===
    JSON.stringify(
      and(
        eq(tables.artworkImagesTable.id as any, "img-1"),
        eq(tables.artworkImagesTable.tenantId as any, "tenant-A"),
      ),
    )
      ? imageA
      : undefined,
  );
  imagesFindMany.mockResolvedValue([]);
  categoriesFindMany.mockResolvedValue([]);
});

const asTenantB = () =>
  getSession.mockResolvedValue({ userId: "user-2", tenantId: "tenant-B" });

describe("updateArtwork tenant scoping", () => {
  it("returns 'Artwork not found.' for another tenant's artwork and modifies nothing", async () => {
    asTenantB();
    const res = await updateArtwork("art-1", noError, validArtworkForm());
    expect(res).toEqual({ error: "Artwork not found." });
    expect(state.updates).toEqual([]);
    expect(state.deletes).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("always includes the session tenantId in the artwork lookup", async () => {
    await expect(
      updateArtwork("art-1", noError, validArtworkForm()),
    ).rejects.toThrow("REDIRECT:/catalog/art-1?saved=1");
    expect(JSON.stringify(state.artworkFindWhere)).toEqual(
      JSON.stringify(artworkScopedWhere("art-1", "tenant-A")),
    );
    // update proceeds for the owning tenant
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({ title: "Sunset" });
  });

  it("returns 'Artwork not found.' for a nonexistent artwork id", async () => {
    const res = await updateArtwork("no-such-id", noError, validArtworkForm());
    expect(res).toEqual({ error: "Artwork not found." });
    expect(state.updates).toEqual([]);
  });
});

describe("deleteArtwork tenant scoping", () => {
  it("scopes the delete by the session tenantId", async () => {
    asTenantB();
    await deleteArtwork("art-1");
    expect(state.deletes).toHaveLength(1);
    // the delete's where clause carries tenant-B, so tenant-A's row can't match
    expect(JSON.stringify(state.deletes[0].where)).toEqual(
      JSON.stringify(artworkScopedWhere("art-1", "tenant-B")),
    );
  });
});

describe("bulkUpdateStatus tenant scoping", () => {
  it("scopes the bulk update by the session tenantId", async () => {
    asTenantB();
    await bulkUpdateStatus(["art-1", "art-2"], "HIDDEN");
    expect(state.updates).toHaveLength(1);
    const expected = and(
      eq(tables.artworksTable.tenantId as any, "tenant-B"),
      inArray(tables.artworksTable.id as any, ["art-1", "art-2"]),
    );
    expect(JSON.stringify(state.updates[0].where)).toEqual(
      JSON.stringify(expected),
    );
  });

  it("does nothing for an empty id list", async () => {
    await bulkUpdateStatus([], "HIDDEN");
    expect(state.updates).toEqual([]);
  });
});

describe("image actions tenant scoping", () => {
  it("addArtworkImage rejects another tenant's artwork and inserts nothing", async () => {
    asTenantB();
    await expect(
      addArtworkImage("art-1", "/objects/x.jpg", "x.jpg"),
    ).rejects.toThrow("Artwork not found");
    expect(state.inserts).toEqual([]);
  });

  it("deleteArtworkImage rejects another tenant's image and deletes nothing", async () => {
    asTenantB();
    await expect(deleteArtworkImage("img-1")).rejects.toThrow("Image not found");
    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("setPrimaryImage rejects another tenant's artwork and updates nothing", async () => {
    asTenantB();
    await expect(setPrimaryImage("img-1", "art-1")).rejects.toThrow(
      "Artwork not found",
    );
    expect(state.updates).toEqual([]);
  });

  it("reorderImages rejects another tenant's artwork and updates nothing", async () => {
    asTenantB();
    await expect(reorderImages("art-1", ["img-1"])).rejects.toThrow(
      "Artwork not found",
    );
    expect(state.updates).toEqual([]);
  });

  it("deleteArtworkImage proceeds for the owning tenant", async () => {
    await deleteArtworkImage("img-1");
    expect(state.deletes).toHaveLength(1);
    expect(JSON.stringify(state.deletes[0].where)).toEqual(
      JSON.stringify(eq(tables.artworkImagesTable.id as any, "img-1")),
    );
  });
});
