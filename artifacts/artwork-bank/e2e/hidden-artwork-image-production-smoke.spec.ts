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
const productionSmokeUrl = process.env.ARTWORK_BANK_PRODUCTION_SMOKE_URL;
const IMAGE_URL = productionSmokeUrl
  ? new URL(
      `/api/storage/public?path=${encodeURIComponent(OBJECT_PATH)}&smoke=${RUN_ID}`,
      productionSmokeUrl,
    ).toString()
  : null;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchImageInBrowser(
  page: Page,
  url: string,
  phase: "visible fetch" | "post-hide fetch",
) {
  try {
    return await page.evaluate(async (imageUrl) => {
      const response = await fetch(imageUrl, { cache: "no-store" });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
    }, url);
  } catch (error) {
    throw new Error(
      `[${phase}] Unable to fetch the production artwork image: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function cleanupFixture(objectWasUploaded: boolean) {
  // Always attempt both cleanup paths. A database cleanup failure must not
  // prevent deletion of the production blob (and vice versa).
  const cleanupResults = await Promise.allSettled([
    db.transaction(async (tx) => {
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
    }),
    objectWasUploaded ? deleteObject(OBJECT_PATH) : Promise.resolve(),
  ]);

  const failedCleanup = cleanupResults
    .map((result, index) => ({ result, target: index === 0 ? "database rows" : "blob" }))
    .filter(
      (
        result,
      ): result is {
        result: PromiseRejectedResult;
        target: "database rows" | "blob";
      } => result.result.status === "rejected",
    );

  if (failedCleanup.length > 0) {
    throw new AggregateError(
      failedCleanup.map(({ result }) => result.reason),
      `[fixture cleanup] Failed to remove ${failedCleanup
        .map(({ target }) => target)
        .join(" and ")}: ${failedCleanup
        .map(({ result }) => errorMessage(result.reason))
        .join("; ")}`,
    );
  }
}

test(
  "a hidden artwork image is denied on the next production request",
  async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    if (!IMAGE_URL) {
      throw new Error(
        "ARTWORK_BANK_PRODUCTION_SMOKE_URL is required for the production smoke test.",
      );
    }
    let objectWasUploaded = false;
    let checkFailure: unknown;
    let cleanupFailure: unknown;

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

      try {
        await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
      } catch (error) {
        throw new Error(
          `[visible fetch] Unable to open the deployed app before fetching the artwork image: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      const visible = await fetchImageInBrowser(page, IMAGE_URL, "visible fetch");
      expect(
        visible.status,
        "[visible fetch] Expected the visible artwork image to return HTTP 200.",
      ).toBe(200);
      expect(
        visible.headers["cache-control"],
        "[cache policy] Expected the visible artwork image response to be private, no-store.",
      ).toBe("private, no-store");
      expect(
        visible.headers["content-type"],
        "[visible fetch] Expected the visible artwork image response to be a PNG.",
      ).toContain("image/png");

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
      const hidden = await fetchImageInBrowser(
        page,
        IMAGE_URL,
        "post-hide fetch",
      );
      expect(
        hidden.status,
        "[post-hide fetch] Expected the same image URL to return HTTP 404 after the artwork is hidden.",
      ).toBe(404);
    } catch (error) {
      checkFailure = error;
    }

    try {
      await cleanupFixture(objectWasUploaded);
    } catch (error) {
      cleanupFailure = error;
    }

    if (checkFailure && cleanupFailure) {
      throw new AggregateError(
        [checkFailure, cleanupFailure],
        `[fixture cleanup] The smoke check failed with "${errorMessage(checkFailure)}" and cleanup also failed with "${errorMessage(cleanupFailure)}".`,
        { cause: checkFailure },
      );
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    if (checkFailure) {
      throw checkFailure;
    }
  },
);