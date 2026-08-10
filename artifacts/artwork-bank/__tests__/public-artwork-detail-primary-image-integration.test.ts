/**
 * Public artwork detail page — primary image join — real-DB integration.
 *
 * app/t/[slug]/[artworkId]/page.tsx queries artworkImagesTable for images
 * and joins the primary image. This suite verifies:
 *
 *  1. Primary image objectPath is present on the detail query.
 *  2. Non-primary images are returned in sortOrder ASC order.
 *  3. When multiple images exist, only one is marked isPrimary.
 *  4. Artwork with no images returns empty images array.
 *  5. Foreign tenant artwork images are not returned.
 *  6. Primary image can be identified by isPrimary=true.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdImageIds: string[] = [];

function uid() { return `${randomUUID()}-padpi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Detail Image Test Gallery", type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Detail Image Test Art", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertImage(artworkId: string, tenantId: string, opts: {
  objectPath?: string;
  sortOrder?: number;
  isPrimary?: boolean;
} = {}) {
  const id = uid();
  const objectPath = opts.objectPath ?? `/objects/${id}.jpg`;
  await db.insert(artworkImagesTable).values({
    id, artworkId, tenantId,
    objectPath,
    filename: `${id}.jpg`,
    sortOrder: opts.sortOrder ?? 0,
    isPrimary: opts.isPrimary ?? false,
  } as any);
  createdImageIds.push(id);
  return { id, objectPath };
}

/** Mirror the public detail page image query. */
async function detailImages(artworkId: string) {
  return db.query.artworkImagesTable.findMany({
    where: eq(artworkImagesTable.artworkId, artworkId),
    orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
  });
}

async function cleanup() {
  for (const id of createdImageIds.splice(0)) {
    await db.delete(artworkImagesTable).where(eq(artworkImagesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Public artwork detail — primary image join — real-DB integration", () => {
  it("primary image objectPath is present on the detail query", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id } = await insertImage(artworkId, tenantId, {
      objectPath: "/objects/primary-test.jpg",
      isPrimary: true,
      sortOrder: 0,
    });

    const images = await detailImages(artworkId);
    const primary = images.find(i => i.isPrimary);

    expect(primary).toBeDefined();
    expect(primary?.id).toBe(id);
    expect(primary?.objectPath).toBe("/objects/primary-test.jpg");
  });

  it("images are returned in sortOrder ASC order", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const img2 = await insertImage(artworkId, tenantId, { sortOrder: 2 });
    const img0 = await insertImage(artworkId, tenantId, { sortOrder: 0, isPrimary: true });
    const img1 = await insertImage(artworkId, tenantId, { sortOrder: 1 });

    const images = await detailImages(artworkId);
    expect(images[0]!.id).toBe(img0.id);
    expect(images[1]!.id).toBe(img1.id);
    expect(images[2]!.id).toBe(img2.id);
  });

  it("when multiple images exist, only one is marked isPrimary", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await insertImage(artworkId, tenantId, { sortOrder: 0, isPrimary: true });
    await insertImage(artworkId, tenantId, { sortOrder: 1, isPrimary: false });
    await insertImage(artworkId, tenantId, { sortOrder: 2, isPrimary: false });

    const images = await detailImages(artworkId);
    const primaries = images.filter(i => i.isPrimary);
    expect(primaries).toHaveLength(1);
  });

  it("artwork with no images returns empty array", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const images = await detailImages(artworkId);
    expect(images).toHaveLength(0);
  });

  it("foreign tenant artwork images are not returned in own-tenant query", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const ownArtworkId     = await createArtwork(ownId);
    const foreignArtworkId = await createArtwork(foreignId);

    await insertImage(ownArtworkId,     ownId,     { sortOrder: 0 });
    const { id: foreignImgId } = await insertImage(foreignArtworkId, foreignId, { sortOrder: 0 });

    const ownImages = await detailImages(ownArtworkId);
    expect(ownImages.some(i => i.id === foreignImgId)).toBe(false);
  });

  it("primary image can be identified by isPrimary=true", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id: primaryId } = await insertImage(artworkId, tenantId, { sortOrder: 0, isPrimary: true });
    const { id: secondId }  = await insertImage(artworkId, tenantId, { sortOrder: 1, isPrimary: false });

    const images = await detailImages(artworkId);
    const primary = images.find(i => i.isPrimary);
    const secondary = images.find(i => !i.isPrimary);

    expect(primary?.id).toBe(primaryId);
    expect(secondary?.id).toBe(secondId);
  });
});
