/**
 * Admin inquiry detail query — real-DB integration.
 *
 * The admin inquiry detail page loads a single inquiry record with:
 *   - buyerName, buyerEmail, message, status, artworkTitle, createdAt
 *   - tenantId scoping (no cross-tenant leakage)
 *
 * No dedicated integration test existed for this path.
 *
 *  1. Loads a single inquiry with all expected fields.
 *  2. Foreign tenant inquiry is not retrievable via own tenant query.
 *  3. Nonexistent inquiry ID returns no row.
 *  4. Inquiry artworkTitle reflects the snapshot stored at submission time.
 *  5. Status field is correct (NEW, HANDLED etc.).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-idqi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Inquiry Detail Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, title = "Detail Test Art") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title, sku: `sku-${id}`, status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string, opts: {
  status?: string;
  artworkTitle?: string;
  buyerName?: string;
  buyerEmail?: string;
  message?: string;
} = {}) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: opts.artworkTitle ?? "Detail Test Art",
    buyerName: opts.buyerName ?? "Inquiry Buyer",
    buyerEmail: opts.buyerEmail ?? `buyer-${id}@test.com`,
    message: opts.message ?? "Is this available?",
    status: opts.status ?? "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

/** Mirror of the admin inquiry detail query. */
async function loadInquiry(inquiryId: string, tenantId: string) {
  return db.query.inquiriesTable.findFirst({
    where: and(
      eq(inquiriesTable.id, inquiryId),
      eq(inquiriesTable.tenantId, tenantId),
    ),
  });
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
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

describeIntegration("Admin inquiry detail query — real-DB integration", () => {
  it("loads a single inquiry with all expected fields", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Detail Query Art");
    const inquiryId = await createInquiry(tenantId, artworkId, {
      buyerName: "Detail Buyer",
      buyerEmail: "detail@buyer.com",
      message: "Tell me more.",
      artworkTitle: "Detail Query Art",
    });

    const row = await loadInquiry(inquiryId, tenantId);

    expect(row).not.toBeNull();
    expect(row?.buyerName).toBe("Detail Buyer");
    expect(row?.buyerEmail).toBe("detail@buyer.com");
    expect(row?.message).toBe("Tell me more.");
    expect(row?.artworkTitle).toBe("Detail Query Art");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.status).toBe("NEW");
  });

  it("foreign tenant inquiry is not retrievable via own tenant query", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const foreignArtworkId = await createArtwork(foreignId);
    const foreignInquiryId = await createInquiry(foreignId, foreignArtworkId);

    const row = await loadInquiry(foreignInquiryId, ownId); // wrong tenantId
    expect(row).toBeUndefined();
  });

  it("nonexistent inquiry ID returns undefined", async () => {
    const { tenantId } = await createTenant();
    const row = await loadInquiry(uid(), tenantId);
    expect(row).toBeUndefined();
  });

  it("artworkTitle reflects the snapshot stored at inquiry creation time", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId, "Snapshot Title at Submit");
    const inquiryId = await createInquiry(tenantId, artworkId, {
      artworkTitle: "Snapshot Title at Submit",
    });

    // Rename the artwork.
    await db.update(artworksTable).set({ title: "Later Renamed Title" }).where(eq(artworksTable.id, artworkId));

    const row = await loadInquiry(inquiryId, tenantId);
    expect(row?.artworkTitle).toBe("Snapshot Title at Submit");
  });

  it("HANDLED status is persisted and loaded correctly", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, { status: "HANDLED" });

    const row = await loadInquiry(inquiryId, tenantId);
    expect(row?.status).toBe("HANDLED");
  });
});
