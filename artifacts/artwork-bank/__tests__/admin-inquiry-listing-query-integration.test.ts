/**
 * Admin inquiries listing page query — status filter — real-DB integration.
 *
 * app/(admin)/(gated)/inquiries/page.tsx:56-75:
 *   status=new   → WHERE tenantId=X AND archivedAt IS NULL AND status=NEW
 *   status=handled → WHERE tenantId=X AND archivedAt IS NULL AND status=HANDLED
 *   status=archived → WHERE tenantId=X AND archivedAt IS NOT NULL
 *   status=all (default) → WHERE tenantId=X AND archivedAt IS NULL
 *   + ordered by createdAt DESC
 *
 *  1. status=new → only NEW + non-archived inquiries returned.
 *  2. status=handled → only HANDLED + non-archived inquiries returned.
 *  3. status=archived → only archived (archivedAt IS NOT NULL) inquiries.
 *  4. status=all → NEW + HANDLED but NOT archived.
 *  5. Another tenant's inquiries excluded (tenant scoping).
 *  6. Results ordered DESC by createdAt.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, inquiriesTable,
} from "@workspace/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-ailqi-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "Inquiry List Test", type: "ARTIST" } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({ id, tenantId, title: "Inquiry Art", sku: `sku-${id}`, status: "AVAILABLE", price: 10000, showInGallery: true } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string, opts: { status?: "NEW" | "HANDLED"; archived?: boolean } = {}) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Inquiry Art",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Interested!",
    status: opts.status ?? "NEW",
    archivedAt: opts.archived ? new Date() : null,
  } as any);
  createdInquiryIds.push(id);
  return id;
}

// Mirrors page.tsx query logic.
async function queryInquiries(tenantId: string, filter: "new" | "handled" | "archived" | "all") {
  const tenantWhere = eq(inquiriesTable.tenantId, tenantId);
  const where =
    filter === "archived"
      ? and(tenantWhere, isNotNull(inquiriesTable.archivedAt))
      : filter === "all"
        ? and(tenantWhere, isNull(inquiriesTable.archivedAt))
        : and(
            tenantWhere,
            isNull(inquiriesTable.archivedAt),
            eq(inquiriesTable.status, filter === "new" ? "NEW" : "HANDLED"),
          );
  return db.select().from(inquiriesTable).where(where).orderBy(desc(inquiriesTable.createdAt));
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

describeIntegration("Admin inquiry listing query — status filter — real-DB integration", () => {
  it("status=new → only NEW + non-archived inquiries returned", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const newInq     = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const handledInq = await createInquiry(tenantId, artworkId, { status: "HANDLED" });
    const archivedInq = await createInquiry(tenantId, artworkId, { status: "NEW", archived: true });

    const rows = await queryInquiries(tenantId, "new");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(newInq);
    expect(ids).not.toContain(handledInq);
    expect(ids).not.toContain(archivedInq);
  });

  it("status=handled → only HANDLED + non-archived inquiries returned", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const newInq     = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const handledInq = await createInquiry(tenantId, artworkId, { status: "HANDLED" });
    const archivedHandled = await createInquiry(tenantId, artworkId, { status: "HANDLED", archived: true });

    const rows = await queryInquiries(tenantId, "handled");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(handledInq);
    expect(ids).not.toContain(newInq);
    expect(ids).not.toContain(archivedHandled);
  });

  it("status=archived → only archived inquiries returned", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const newInq     = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const archivedInq = await createInquiry(tenantId, artworkId, { status: "NEW", archived: true });

    const rows = await queryInquiries(tenantId, "archived");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(archivedInq);
    expect(ids).not.toContain(newInq);
  });

  it("status=all → NEW + HANDLED but NOT archived", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const newInq     = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const handledInq = await createInquiry(tenantId, artworkId, { status: "HANDLED" });
    const archivedInq = await createInquiry(tenantId, artworkId, { status: "NEW", archived: true });

    const rows = await queryInquiries(tenantId, "all");
    const ids = rows.map(r => r.id);

    expect(ids).toContain(newInq);
    expect(ids).toContain(handledInq);
    expect(ids).not.toContain(archivedInq);
  });

  it("another tenant's inquiries are excluded (tenant scoping)", async () => {
    const tenantA   = await createTenant();
    const tenantB   = await createTenant();
    const artA      = await createArtwork(tenantA);
    const artB      = await createArtwork(tenantB);
    const inqA      = await createInquiry(tenantA, artA);
    const inqB      = await createInquiry(tenantB, artB);

    const rowsA = await queryInquiries(tenantA, "all");
    const idsA = rowsA.map(r => r.id);

    expect(idsA).toContain(inqA);
    expect(idsA).not.toContain(inqB);
  });

  it("results ordered by createdAt DESC (newest first)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inq1      = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const inq2      = await createInquiry(tenantId, artworkId, { status: "NEW" });
    const inq3      = await createInquiry(tenantId, artworkId, { status: "NEW" });

    const rows = await queryInquiries(tenantId, "new");
    const ids = rows.map(r => r.id).filter(id => [inq1, inq2, inq3].includes(id));

    // inq3 was inserted last → should appear first.
    const idx3 = ids.indexOf(inq3);
    const idx1 = ids.indexOf(inq1);
    expect(idx3).toBeLessThan(idx1);
  });
});
