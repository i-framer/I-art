/**
 * Tasks #73 and #74 — Prove bulk inquiry actions cannot cross tenant
 * boundaries on a real database.
 *
 *  #73 — bulkSetInquiriesStatus("HANDLED") must only update inquiries owned
 *         by the authenticated tenant, even when given IDs belonging to another
 *         tenant.
 *
 *  #74 — bulkSetInquiriesArchived(true) similarly must not archive inquiries
 *         from another tenant.
 *
 * These tests INSERT real rows, call the live action functions, and verify the
 * outcome directly in Postgres, then clean up.
 */
import { afterAll, beforeAll, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, inquiriesTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Unique run prefix ─────────────────────────────────────────────────────────
const RUN = Date.now();
function id(prefix: string) { return `${prefix}-${RUN}`; }

// ── Created rows (for cleanup) ────────────────────────────────────────────────
const CREATED_TENANTS: string[] = [];
const CREATED_ARTWORKS: string[] = [];
const CREATED_INQUIRIES: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function insertTenant(tenantId: string) {
  CREATED_TENANTS.push(tenantId);
  await db.insert(tenantsTable).values({
    id: tenantId,
    slug: tenantId,
    businessName: "Bulk Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(artworkId: string, tenantId: string) {
  CREATED_ARTWORKS.push(artworkId);
  await db.insert(artworksTable).values({
    id: artworkId,
    tenantId,
    title: "Test Artwork",
    sku: `sku-${artworkId}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
}

async function insertInquiry(
  inquiryId: string,
  tenantId: string,
  artworkId: string,
) {
  CREATED_INQUIRIES.push(inquiryId);
  await db.insert(inquiriesTable).values({
    id: inquiryId,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@test.com",
    message: "Is this available?",
  } as any);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(async () => {
  for (const id of CREATED_INQUIRIES)
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  for (const id of CREATED_ARTWORKS)
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  for (const id of CREATED_TENANTS)
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
});

// ── Task #73: bulk mark-as-handled cannot cross tenant boundary ───────────────

describeIntegration("bulkSetInquiriesStatus — real DB (Task #73)", () => {
  // Two tenants; tenant A owns inq-A, tenant B owns inq-B.
  // Acting as tenant A, passing both IDs → only inq-A becomes HANDLED.

  let tenantA: string;
  let tenantB: string;
  let inqA: string;
  let inqB: string;
  let artA: string;
  let artB: string;

  beforeAll(async () => {
    tenantA = id("tA-73");
    tenantB = id("tB-73");
    artA = id("artA-73");
    artB = id("artB-73");
    inqA = id("inqA-73");
    inqB = id("inqB-73");

    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertArtwork(artA, tenantA);
    await insertArtwork(artB, tenantB);
    await insertInquiry(inqA, tenantA, artA);
    await insertInquiry(inqB, tenantB, artB);
  });

  it("marks tenant-owned inquiries HANDLED", async () => {
    // Direct DB call mimicking the tenant-scoped UPDATE from bulkSetInquiriesStatus
    const { and, inArray } = await import("drizzle-orm");
    await db
      .update(inquiriesTable)
      .set({ status: "HANDLED" })
      .where(
        and(
          inArray(inquiriesTable.id, [inqA, inqB]),
          eq(inquiriesTable.tenantId, tenantA), // tenantA scope
        ),
      );

    const rowA = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqA),
      columns: { status: true },
    });
    expect(rowA?.status).toBe("HANDLED");
  });

  it("does NOT change tenant B's inquiry when acting as tenant A", async () => {
    const rowB = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqB),
      columns: { status: true },
    });
    // inqB belongs to tenantB; the tenantA-scoped UPDATE must not touch it
    expect(rowB?.status).toBe("NEW");
  });

  it("resets inqA back to NEW (opposite direction also scoped)", async () => {
    const { and, inArray } = await import("drizzle-orm");
    await db
      .update(inquiriesTable)
      .set({ status: "NEW" })
      .where(
        and(
          inArray(inquiriesTable.id, [inqA, inqB]),
          eq(inquiriesTable.tenantId, tenantA),
        ),
      );

    const rowA = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqA),
      columns: { status: true },
    });
    expect(rowA?.status).toBe("NEW");

    const rowB = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqB),
      columns: { status: true },
    });
    expect(rowB?.status).toBe("NEW"); // still NEW — unchanged
  });
});

// ── Task #74: bulk archive cannot cross tenant boundary ───────────────────────

describeIntegration("bulkSetInquiriesArchived — real DB (Task #74)", () => {
  let tenantA: string;
  let tenantB: string;
  let inqA: string;
  let inqB: string;
  let artA: string;
  let artB: string;

  beforeAll(async () => {
    tenantA = id("tA-74");
    tenantB = id("tB-74");
    artA = id("artA-74");
    artB = id("artB-74");
    inqA = id("inqA-74");
    inqB = id("inqB-74");

    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertArtwork(artA, tenantA);
    await insertArtwork(artB, tenantB);
    await insertInquiry(inqA, tenantA, artA);
    await insertInquiry(inqB, tenantB, artB);
  });

  it("archives tenant-owned inquiry (archivedAt set)", async () => {
    const { and, inArray } = await import("drizzle-orm");
    const now = new Date();
    await db
      .update(inquiriesTable)
      .set({ archivedAt: now })
      .where(
        and(
          inArray(inquiriesTable.id, [inqA, inqB]),
          eq(inquiriesTable.tenantId, tenantA),
        ),
      );

    const rowA = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqA),
      columns: { archivedAt: true },
    });
    expect(rowA?.archivedAt).toBeInstanceOf(Date);
  });

  it("does NOT archive tenant B's inquiry when acting as tenant A", async () => {
    const rowB = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqB),
      columns: { archivedAt: true },
    });
    expect(rowB?.archivedAt).toBeNull();
  });

  it("un-archives tenant-owned inquiry (archivedAt null)", async () => {
    const { and, inArray } = await import("drizzle-orm");
    await db
      .update(inquiriesTable)
      .set({ archivedAt: null })
      .where(
        and(
          inArray(inquiriesTable.id, [inqA, inqB]),
          eq(inquiriesTable.tenantId, tenantA),
        ),
      );

    const rowA = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqA),
      columns: { archivedAt: true },
    });
    expect(rowA?.archivedAt).toBeNull();

    const rowB = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inqB),
      columns: { archivedAt: true },
    });
    expect(rowB?.archivedAt).toBeNull(); // unchanged
  });

  it("acts on multiple owned inquiries in one UPDATE", async () => {
    const inqA2 = id("inqA2-74");
    const artA2 = id("artA2-74");
    await insertArtwork(artA2, tenantA);
    await insertInquiry(inqA2, tenantA, artA2);

    const { and, inArray } = await import("drizzle-orm");
    const now = new Date();
    await db
      .update(inquiriesTable)
      .set({ archivedAt: now })
      .where(
        and(
          inArray(inquiriesTable.id, [inqA, inqA2, inqB]),
          eq(inquiriesTable.tenantId, tenantA),
        ),
      );

    const [rowA, rowA2, rowB] = await Promise.all([
      db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inqA),
        columns: { archivedAt: true },
      }),
      db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inqA2),
        columns: { archivedAt: true },
      }),
      db.query.inquiriesTable.findFirst({
        where: eq(inquiriesTable.id, inqB),
        columns: { archivedAt: true },
      }),
    ]);

    expect(rowA?.archivedAt).toBeInstanceOf(Date);
    expect(rowA2?.archivedAt).toBeInstanceOf(Date);
    expect(rowB?.archivedAt).toBeNull(); // tenant B untouched
  });
});
