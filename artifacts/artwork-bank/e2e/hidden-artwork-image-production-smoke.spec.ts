import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  artworkImagesTable,
  artworksTable,
  db,
  tenantsTable,
} from "@workspace/db";
import {
  deleteObject,
  getStorageProvider,
  putObject,
} from "@/lib/object-storage";

const RUN_ID = randomUUID();
const TENANT_ID = `production-smoke-tenant-${RUN_ID}`;
const ARTWORK_ID = `production-smoke-artwork-${RUN_ID}`;
const OBJECT_PATH = `/objects/uploads/${RUN_ID}`;
const OBJECT_ENTITY_ID = `uploads/${RUN_ID}`;
const IMAGE_URL = new URL(
  `/api/storage/public?path=${encodeURIComponent(OBJECT_PATH)}&smoke=${RUN_ID}`,
  process.env.ARTWORK_BANK_PRODUCTION_SMOKE_URL,
).toString();

// Valid, minimal 1×1 PNG. The bytes have no customer or artwork content.
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function fetchImageInBrowser(page: Page, url: string) {
  return page.evaluate(async (imageUrl) => {
    const response = await fetch(imageUrl, { cache: "no-store" });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }, url);
}

async function cleanupFixture(objectWasUploaded: boolean) {
  await db.transaction(async (tx) => {
    await tx
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.artworkId, ARTWORK_ID));
    await tx
      .delete(artworksTable)
      .where(
        and(
          eq(artworksTable.id, ARTWORK_ID),
          eq(artworksTable.tenantId, TENANT_ID),
        ),
      );
    await tx.delete(tenantsTable).where(eq(tenantsTable.id, TENANT_ID));
  });

  if (objectWasUploaded) {
    await deleteObject(OBJECT_PATH);
  }
}

test(
  "a hidden artwork image is denied on the next production request",
  async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    let objectWasUploaded = false;

    try {
      expect(getStorageProvider()).toBe("vercel-blob");

      await putObject(
        OBJECT_ENTITY_ID,
        new Blob([PNG_1X1], { type: "image/png" }),
        "image/png",
      );
      objectWasUploaded = true;

      await db.transaction(async (tx) => {
        await tx.insert(tenantsTable).values({
          id: TENANT_ID,
          slug: `production-smoke-${RUN_ID}`,
          businessName: `Production image smoke ${RUN_ID.slice(0, 8)}`,
          type: "ARTIST",
          billingExempt: true,
        });
        await tx.insert(artworksTable).values({
          id: ARTWORK_ID,
          tenantId: TENANT_ID,
          title: "Production image smoke fixture",
          sku: `production-smoke-${RUN_ID}`,
          status: "AVAILABLE",
          showInGallery: true,
        });
        await tx.insert(artworkImagesTable).values({
          artworkId: ARTWORK_ID,
          tenantId: TENANT_ID,
          objectPath: OBJECT_PATH,
          filename: "production-smoke.png",
          isPrimary: true,
        });
      });

      await page.goto(baseURL!, { waitUntil: "domcontentloaded" });

      const visible = await fetchImageInBrowser(page, IMAGE_URL);
      expect(visible.status).toBe(200);
      expect(visible.headers["cache-control"]).toBe("private, no-store");
      expect(visible.headers["content-type"]).toContain("image/png");

      await db
        .update(artworksTable)
        .set({ showInGallery: false })
        .where(
          and(
            eq(artworksTable.id, ARTWORK_ID),
            eq(artworksTable.tenantId, TENANT_ID),
          ),
        );

      // Use the exact URL requested above. A 200 here means an edge/browser
      // cache served the previous response instead of reauthorizing visibility.
      const hidden = await fetchImageInBrowser(page, IMAGE_URL);
      expect(hidden.status).toBe(404);
    } finally {
      await cleanupFixture(objectWasUploaded);
    }
  },
);