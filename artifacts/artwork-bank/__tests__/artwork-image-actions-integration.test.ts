/**
 * Artwork image management actions — real-DB integration.
 *
 * addArtworkImage / deleteArtworkImage / setPrimaryImage / reorderImages.
 *
 * Verifies DB persistence, primary-image invariants, and tenant-isolation
 * against real PostgreSQL. Object storage is mocked (no real blobs).
 *
 *  addArtworkImage:
 *   1. Inserts an image row; first image becomes primary.
 *   2. Second image is not primary; sortOrder incremented.
 *
 *  deleteArtworkImage:
 *   3. Removes the row; when primary deleted, next image promoted to primary.
 *   4. Rejects a foreign tenant's imageId (tenant-scoped artwork check).
 *
 *  setPrimaryImage:
 *   5. Sets exactly one image to isPrimary=true, all others false.
 *
 *  reorderImages:
 *   6. Updates sortOrder for each image to match supplied orderedIds.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkImagesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockTenantId = { value: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-img-actions", tenantId: mockTenantId.value })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// ── Object storage — no-op ────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(async () => {}),
  getServeUrl: vi.fn(async () => "https://img.test/photo.jpg"),
  StorageNotConfiguredError: class extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import {
  addArtworkImage,
  deleteArtworkImage,
  setPrimaryImage,
  reorderImages,
} from "@/app/(admin)/(gated)/catalog/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() {
  return `${randomUUID()}-img-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Image Action Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockTenantId.value = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkImagesTable)
      .where(eq(artworkImagesTable.artworkId, id))
      .catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Artwork image management — real-DB integration", () => {
  // ── addArtworkImage ────────────────────────────────────────────────────────

  it("addArtworkImage: first image is inserted as primary with sortOrder=0", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const images = await addArtworkImage(
      artworkId,
      `/objects/${uid()}.jpg`,
      "photo.jpg",
    );

    expect(images).toHaveLength(1);
    expect(images[0].isPrimary).toBe(true);
    expect(images[0].sortOrder).toBe(0);
    expect(images[0].artworkId).toBe(artworkId);
  });

  it("addArtworkImage: second image is not primary; sortOrder=1", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "first.jpg");
    const images = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "second.jpg");

    expect(images).toHaveLength(2);
    const second = images.find((i) => i.filename === "second.jpg");
    expect(second?.isPrimary).toBe(false);
    expect(second?.sortOrder).toBe(1);
  });

  // ── deleteArtworkImage ─────────────────────────────────────────────────────

  it("deleteArtworkImage: removes the image row", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const [first] = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "del.jpg");

    const remaining = await deleteArtworkImage(first.id);

    expect(remaining).toHaveLength(0);
    const row = await db.query.artworkImagesTable.findFirst({
      where: eq(artworkImagesTable.id, first.id),
    });
    expect(row).toBeUndefined();
  });

  it("deleteArtworkImage: promotes next image to primary when primary is deleted", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const [primary] = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "primary.jpg");
    await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "secondary.jpg");

    const remaining = await deleteArtworkImage(primary.id);

    // The remaining image (secondary) must now be primary.
    expect(remaining).toHaveLength(1);
    expect(remaining[0].isPrimary).toBe(true);
    expect(remaining[0].filename).toBe("secondary.jpg");
  });

  it("deleteArtworkImage: throws for a foreign tenant's artworkId", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const [img] = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "photo.jpg");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockTenantId.value = tenantB;

    await expect(deleteArtworkImage(img.id)).rejects.toThrow(
      /not found|not authorized|unauthorized/i,
    );

    // Image must still exist.
    const row = await db.query.artworkImagesTable.findFirst({
      where: eq(artworkImagesTable.id, img.id),
    });
    expect(row).toBeDefined();
  });

  // ── setPrimaryImage ────────────────────────────────────────────────────────

  it("setPrimaryImage: exactly one image is primary after the call", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const [img1] = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "img1.jpg");
    const imgs = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "img2.jpg");
    const img2 = imgs.find((i) => i.filename === "img2.jpg")!;

    const updated = await setPrimaryImage(img2.id, artworkId);

    const primary = updated.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0].id).toBe(img2.id);

    const notPrimary = updated.find((i) => i.id === img1.id);
    expect(notPrimary?.isPrimary).toBe(false);
  });

  // ── reorderImages ──────────────────────────────────────────────────────────

  it("reorderImages: persists sortOrder matching the supplied orderedIds", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "img-a.jpg");
    const imgs = await addArtworkImage(artworkId, `/objects/${uid()}.jpg`, "img-b.jpg");

    const imgA = imgs.find((i) => i.filename === "img-a.jpg")!;
    const imgB = imgs.find((i) => i.filename === "img-b.jpg")!;

    // Reverse the order.
    const reordered = await reorderImages(artworkId, [imgB.id, imgA.id]);

    const afterA = reordered.find((i) => i.id === imgA.id)!;
    const afterB = reordered.find((i) => i.id === imgB.id)!;

    expect(afterB.sortOrder).toBe(0);
    expect(afterA.sortOrder).toBe(1);
  });
});
