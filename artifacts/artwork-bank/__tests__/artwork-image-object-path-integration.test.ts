/**
 * Artwork image objectPath field — persistence — real-DB integration.
 *
 * artworkImagesTable.objectPath is NOT NULL (lib/db/src/schema/artworkImage.ts:18).
 * The production gallery query uses it to build a serve URL via getServeUrl().
 *
 * This suite verifies:
 *
 *  1. objectPath is persisted and read back correctly.
 *  2. objectPath is returned via the admin edit-page query.
 *  3. The primary image's objectPath is present on the joined browse/gallery query.
 *  4. objectPath can be updated (e.g. re-upload path change).
 *  5. Each image has its own objectPath (multi-image artwork isolation).
 *  6. Foreign-tenant images are not returned in own-tenant query.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdImageIds: string[] = [];

function uid() { return `${randomUUID()}-aiop-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Image Object Path Test Gallery", type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Image Path Test Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function insertImage(artworkId: string, tenantId: string, opts: {
  objectPath?: string;
  filename?: string;
  isPrimary?: boolean;
  sortOrder?: number;
} = {}) {
  const id = uid();
  const objectPath = opts.objectPath ?? `/objects/${id}.jpg`;
  await db.insert(artworkImagesTable).values({
    id, artworkId, tenantId,
    objectPath,
    filename: opts.filename ?? `${id}.jpg`,
    isPrimary: opts.isPrimary ?? false,
    sortOrder: opts.sortOrder ?? 0,
  } as any);
  createdImageIds.push(id);
  return { id, objectPath };
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

describeIntegration("Artwork image objectPath field — persistence — real-DB integration", () => {
  it("objectPath is persisted and read back correctly", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id } = await insertImage(artworkId, tenantId, {
      objectPath: "/objects/my-painting-abc123.jpg",
    });

    const img = await db.query.artworkImagesTable.findFirst({ where: eq(artworkImagesTable.id, id) });
    expect(img?.objectPath).toBe("/objects/my-painting-abc123.jpg");
  });

  it("objectPath is returned via the admin edit-page image query", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id } = await insertImage(artworkId, tenantId, {
      objectPath: "/objects/edit-page-test.jpg",
      sortOrder: 0,
    });

    // Mirror the admin edit-page image query.
    const images = await db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.artworkId, artworkId),
      orderBy: (t, { asc }) => [asc(t.sortOrder)],
    });

    const img = images.find(i => i.id === id);
    expect(img?.objectPath).toBe("/objects/edit-page-test.jpg");
  });

  it("primary image objectPath is present on the joined browse query", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await insertImage(artworkId, tenantId, {
      objectPath: "/objects/primary.jpg",
      isPrimary: true,
      sortOrder: 0,
    });

    // Mirror the browse page left-join for primary image.
    const rows = await db
      .select({
        artworkId: artworksTable.id,
        primaryObjectPath: artworkImagesTable.objectPath,
      })
      .from(artworksTable)
      .leftJoin(
        artworkImagesTable,
        and(
          eq(artworkImagesTable.artworkId, artworksTable.id),
          eq(artworkImagesTable.isPrimary, true),
        ),
      )
      .where(eq(artworksTable.id, artworkId));

    expect(rows[0]?.primaryObjectPath).toBe("/objects/primary.jpg");
  });

  it("objectPath can be updated (re-upload path change)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id } = await insertImage(artworkId, tenantId, {
      objectPath: "/objects/old-path.jpg",
    });

    await db.update(artworkImagesTable)
      .set({ objectPath: "/objects/new-path.jpg" })
      .where(eq(artworkImagesTable.id, id));

    const img = await db.query.artworkImagesTable.findFirst({ where: eq(artworkImagesTable.id, id) });
    expect(img?.objectPath).toBe("/objects/new-path.jpg");
  });

  it("each image has its own objectPath (multi-image isolation)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const { id: id1 } = await insertImage(artworkId, tenantId, { objectPath: "/objects/img1.jpg", sortOrder: 0 });
    const { id: id2 } = await insertImage(artworkId, tenantId, { objectPath: "/objects/img2.jpg", sortOrder: 1 });

    const [img1, img2] = await Promise.all([
      db.query.artworkImagesTable.findFirst({ where: eq(artworkImagesTable.id, id1) }),
      db.query.artworkImagesTable.findFirst({ where: eq(artworkImagesTable.id, id2) }),
    ]);

    expect(img1?.objectPath).toBe("/objects/img1.jpg");
    expect(img2?.objectPath).toBe("/objects/img2.jpg");
    expect(img1?.objectPath).not.toBe(img2?.objectPath);
  });

  it("foreign-tenant images are not returned in own-tenant query", async () => {
    const ownTenantId  = await createTenant();
    const foreignTenantId = await createTenant();
    const ownArtworkId = await createArtwork(ownTenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);

    const { id: ownImgId }     = await insertImage(ownArtworkId,     ownTenantId,     { objectPath: "/objects/own.jpg" });
    const { id: foreignImgId } = await insertImage(foreignArtworkId, foreignTenantId, { objectPath: "/objects/foreign.jpg" });

    const ownImages = await db.query.artworkImagesTable.findMany({
      where: eq(artworkImagesTable.tenantId, ownTenantId),
    });

    const ownIds = ownImages.map(i => i.id);
    expect(ownIds).toContain(ownImgId);
    expect(ownIds).not.toContain(foreignImgId);
  });
});
