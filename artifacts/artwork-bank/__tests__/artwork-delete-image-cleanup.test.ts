/**
 * Regression tests: deleteArtwork cleans up stored image files.
 *
 * When an artwork is deleted its image rows are cascade-deleted by the DB,
 * but the actual stored files must also be removed. deleteArtwork must fetch
 * all image objectPaths before deleting the row, then best-effort delete each
 * stored file. A storage failure must not prevent the artwork deletion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

const state = vi.hoisted(() => ({
  deletes: [] as { table: any; where: any }[],
  imageQueryWhere: null as any,
}));

const tables = vi.hoisted(() => ({
  artworksTable: { id: "artworks.id", tenantId: "artworks.tenantId" },
  artworkImagesTable: {
    id: "images.id",
    tenantId: "images.tenantId",
    artworkId: "images.artworkId",
    objectPath: "images.objectPath",
    sortOrder: "images.sortOrder",
    createdAt: "images.createdAt",
  },
  artworkCategoryOnArtworkTable: { artworkId: "acoa.artworkId" },
  artworkCategoriesTable: { id: "categories.id", tenantId: "categories.tenantId" },
}));

const imagesFindMany = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworkImagesTable: {
        findMany: (opts: any) => {
          state.imageQueryWhere = opts?.where;
          return imagesFindMany(opts);
        },
      },
      artworksTable: { findFirst: vi.fn(async () => undefined) },
      artworkCategoriesTable: { findMany: vi.fn(async () => []) },
    },
    delete: vi.fn((table: any) => ({
      where: (where: any) => {
        state.deletes.push({ table, where });
        return Promise.resolve();
      },
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
    insert: vi.fn(() => ({ values: () => Promise.resolve() })),
  },
  ...tables,
}));

const deleteObjectMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/object-storage", () => ({
  deleteObject: deleteObjectMock,
  getObjectUrl: vi.fn(async () => "https://storage.test/img.jpg"),
}));

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ userId: "user-1", tenantId: "tenant-A" })),
);
vi.mock("@/lib/auth", () => ({ getSession: () => getSession() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { deleteArtwork } from "@/app/(admin)/(gated)/catalog/actions";
import { and, eq } from "drizzle-orm";

const j = (v: any) => JSON.stringify(v);

beforeEach(() => {
  vi.clearAllMocks();
  state.deletes.length = 0;
  state.imageQueryWhere = null;
  imagesFindMany.mockResolvedValue([]);
  getSession.mockResolvedValue({ userId: "user-1", tenantId: "tenant-A" });
});

describe("deleteArtwork — image file cleanup", () => {
  it("calls deleteObject for each stored image when artwork is deleted", async () => {
    imagesFindMany.mockResolvedValue([
      { id: "img-1", objectPath: "/objects/img1.jpg", tenantId: "tenant-A", artworkId: "art-1" },
      { id: "img-2", objectPath: "/objects/img2.jpg", tenantId: "tenant-A", artworkId: "art-1" },
    ]);

    await deleteArtwork("art-1");

    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
    expect(deleteObjectMock).toHaveBeenCalledWith("/objects/img1.jpg");
    expect(deleteObjectMock).toHaveBeenCalledWith("/objects/img2.jpg");
  });

  it("deletes the artwork row even when there are no images", async () => {
    imagesFindMany.mockResolvedValue([]);

    await deleteArtwork("art-1");

    expect(state.deletes).toHaveLength(1);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("scopes the image query to the session tenant before fetching paths", async () => {
    await deleteArtwork("art-1");

    const expectedWhere = and(
      eq(tables.artworkImagesTable.artworkId as any, "art-1"),
      eq(tables.artworkImagesTable.tenantId as any, "tenant-A"),
    );
    expect(j(state.imageQueryWhere)).toEqual(j(expectedWhere));
  });

  it("still deletes the artwork row when a storage call fails", async () => {
    imagesFindMany.mockResolvedValue([
      { id: "img-1", objectPath: "/objects/img1.jpg", tenantId: "tenant-A", artworkId: "art-1" },
    ]);
    deleteObjectMock.mockRejectedValue(new Error("storage unavailable"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await deleteArtwork("art-1");

    // DB delete still happened
    expect(state.deletes).toHaveLength(1);
    // Error was logged, not thrown
    await new Promise((r) => setTimeout(r, 10));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("/objects/img1.jpg"),
      expect.any(Error),
    );
  });

  it("does not call deleteObject when an unauthenticated user triggers the action", async () => {
    getSession.mockResolvedValue({} as any);

    await deleteArtwork("art-1");

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(state.deletes).toEqual([]);
  });

  it("uses tenant-B scoping for image query when tenant-B deletes artwork", async () => {
    getSession.mockResolvedValue({ userId: "user-2", tenantId: "tenant-B" });
    await deleteArtwork("art-1");

    const expectedWhere = and(
      eq(tables.artworkImagesTable.artworkId as any, "art-1"),
      eq(tables.artworkImagesTable.tenantId as any, "tenant-B"),
    );
    expect(j(state.imageQueryWhere)).toEqual(j(expectedWhere));
  });
});
