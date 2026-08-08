/**
 * Inquiry page status count queries — real-DB integration.
 *
 * app/(admin)/(gated)/inquiries/page.tsx:84-105 runs two parallel counts:
 *   1. countRow — total for current filter (new/handled/archived)
 *   2. newCountRow — always counts NEW+non-archived inquiries (badge)
 *
 * This suite verifies those query contracts:
 *
 *  1. newCountRow returns only NEW and non-archived inquiries.
 *  2. newCountRow excludes HANDLED inquiries.
 *  3. newCountRow excludes archived inquiries (even if NEW).
 *  4. countRow with filter=new matches only NEW non-archived.
 *  5. countRow with filter=handled matches only HANDLED non-archived.
 *  6. Counts are tenant-scoped (foreign inquiries not counted).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-iscq-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Inquiry Count Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Inquiry Count Test Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, opts: {
  status?: "NEW" | "HANDLED";
  archivedAt?: Date | null;
} = {}) {
  const artworkId = await createArtwork(tenantId);
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId,
    artworkId,
    artworkTitle: "Test Art",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Test message",
    status: opts.status ?? "NEW",
    archivedAt: opts.archivedAt ?? null,
  } as any);
  createdInquiryIds.push(id);
  return id;
}

/** Mirror the inquiry page's newCountRow query for a given tenantId. */
async function newCount(tenantId: string) {
  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, tenantId),
        eq(inquiriesTable.status, "NEW"),
        isNull(inquiriesTable.archivedAt),
      ),
    );
  return row?.count ?? 0;
}

/** Mirror the page's filtered countRow for new/handled filters. */
async function filteredCount(tenantId: string, filter: "new" | "handled") {
  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, tenantId),
        isNull(inquiriesTable.archivedAt),
        eq(inquiriesTable.status, filter === "new" ? "NEW" : "HANDLED"),
      ),
    );
  return row?.count ?? 0;
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

describeIntegration("Inquiry page status count queries — real-DB integration", () => {
  it("newCountRow returns only NEW and non-archived inquiries", async () => {
    const tenantId = await createTenant();
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "NEW" });

    const n = await newCount(tenantId);
    expect(n).toBe(3);
  });

  it("newCountRow excludes HANDLED inquiries", async () => {
    const tenantId = await createTenant();
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "HANDLED" });

    const n = await newCount(tenantId);
    expect(n).toBe(1);
  });

  it("newCountRow excludes archived inquiries even if status is NEW", async () => {
    const tenantId = await createTenant();
    await createInquiry(tenantId, { status: "NEW" }); // not archived — counts
    await createInquiry(tenantId, { status: "NEW", archivedAt: new Date() }); // archived — excluded

    const n = await newCount(tenantId);
    expect(n).toBe(1);
  });

  it("filter=new countRow matches only NEW non-archived inquiries", async () => {
    const tenantId = await createTenant();
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "HANDLED" });
    await createInquiry(tenantId, { status: "NEW", archivedAt: new Date() });

    const n = await filteredCount(tenantId, "new");
    expect(n).toBe(2); // only the two non-archived NEW
  });

  it("filter=handled countRow matches only HANDLED non-archived inquiries", async () => {
    const tenantId = await createTenant();
    await createInquiry(tenantId, { status: "HANDLED" });
    await createInquiry(tenantId, { status: "HANDLED" });
    await createInquiry(tenantId, { status: "NEW" });
    await createInquiry(tenantId, { status: "HANDLED", archivedAt: new Date() });

    const n = await filteredCount(tenantId, "handled");
    expect(n).toBe(2); // only the two non-archived HANDLED
  });

  it("counts are tenant-scoped — foreign inquiries are not counted", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();
    await createInquiry(ownTenantId,     { status: "NEW" });
    await createInquiry(foreignTenantId, { status: "NEW" });
    await createInquiry(foreignTenantId, { status: "NEW" });

    const own     = await newCount(ownTenantId);
    const foreign = await newCount(foreignTenantId);

    expect(own).toBe(1);
    expect(foreign).toBe(2);
  });
});
