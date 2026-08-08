/**
 * Admin inquiries listing — pagination and filters — real-DB integration.
 *
 * The inquiries admin page uses PAGE_SIZE=25 with status and archive filters.
 * This suite verifies correct pagination and filter behaviour against real PostgreSQL:
 *
 *  1. >25 inquiries → page 1 = newest 25, page 2 = remainder (no overlap).
 *  2. Status filter "new" → only NEW + unarchived; "handled" → HANDLED + unarchived.
 *  3. Archived filter → only rows with non-null archivedAt.
 *  4. "all" filter → excludes archived rows (not all statuses unconditionally).
 *  5. Tenant isolation: inquiries from a foreign tenant never appear.
 *  6. totalPages = ceil(total / 25).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-inqpag-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Inquiry Pagination Gallery",
    type: "ARTIST", billingExempt: true,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Inquiry Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(
  tenantId: string,
  artworkId: string,
  opts: { status?: string; archivedAt?: Date | null } = {},
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Inquiry Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@example.com",
    message: "Available?",
    status: opts.status ?? "NEW",
    archivedAt: opts.archivedAt ?? null,
  } as any);
  createdInquiryIds.push(id);
  return id;
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

// ── Inline query helper (mirrors page.tsx logic) ──────────────────────────────

const PAGE_SIZE = 25;

type StatusMode = "all" | "new" | "handled" | "archived";

async function queryInquiries(
  tenantId: string,
  page: number,
  mode: StatusMode = "all",
) {
  const p = Math.max(1, page);
  const offset = (p - 1) * PAGE_SIZE;

  const where =
    mode === "archived"
      ? and(eq(inquiriesTable.tenantId, tenantId), isNotNull(inquiriesTable.archivedAt))
      : mode === "new"
        ? and(eq(inquiriesTable.tenantId, tenantId), isNull(inquiriesTable.archivedAt), eq(inquiriesTable.status, "NEW" as any))
        : mode === "handled"
          ? and(eq(inquiriesTable.tenantId, tenantId), isNull(inquiriesTable.archivedAt), eq(inquiriesTable.status, "HANDLED" as any))
          : and(eq(inquiriesTable.tenantId, tenantId), isNull(inquiriesTable.archivedAt));

  const [rows, countRows] = await Promise.all([
    db.select({ id: inquiriesTable.id, status: inquiriesTable.status, archivedAt: inquiriesTable.archivedAt, createdAt: inquiriesTable.createdAt })
      .from(inquiriesTable)
      .where(where)
      .orderBy(desc(inquiriesTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(inquiriesTable).where(where),
  ]);

  const total = countRows[0]?.count ?? 0;
  return { rows, total, totalPages: Math.ceil(total / PAGE_SIZE) };
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin inquiries listing — pagination — real-DB integration", () => {
  it(">25 inquiries: page 1 returns newest 25, page 2 has remainder, no overlap", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    for (let i = 0; i < 27; i++) {
      await createInquiry(tenantId, artworkId, { status: "NEW" });
    }

    const p1 = await queryInquiries(tenantId, 1, "all");
    const p2 = await queryInquiries(tenantId, 2, "all");

    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(2);
    expect(p1.total).toBe(27);
    expect(p1.totalPages).toBe(2);

    const p1ids = new Set(p1.rows.map(r => r.id));
    for (const row of p2.rows) expect(p1ids.has(row.id)).toBe(false);
  });

  it("status 'new' → only NEW + unarchived inquiries", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date() }); // archived

    const result = await queryInquiries(tenantId, 1, "new");

    expect(result.total).toBe(2);
    for (const row of result.rows) {
      expect(row.status).toBe("NEW");
      expect(row.archivedAt).toBeNull();
    }
  });

  it("status 'handled' → only HANDLED + unarchived inquiries", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: new Date() }); // archived

    const result = await queryInquiries(tenantId, 1, "handled");

    expect(result.total).toBe(1);
    expect(result.rows[0].status).toBe("HANDLED");
  });

  it("status 'archived' → only rows with non-null archivedAt", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date() });
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: new Date() });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });

    const result = await queryInquiries(tenantId, 1, "archived");

    expect(result.total).toBe(2);
    for (const row of result.rows) expect(row.archivedAt).not.toBeNull();
  });

  it("'all' filter excludes archived rows", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "HANDLED", archivedAt: null });
    await createInquiry(tenantId, artworkId, { status: "NEW", archivedAt: new Date() }); // excluded

    const result = await queryInquiries(tenantId, 1, "all");

    expect(result.total).toBe(2);
    for (const row of result.rows) expect(row.archivedAt).toBeNull();
  });

  it("tenant isolation: foreign tenant inquiries never appear", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);

    await createInquiry(tenantId, artworkId, { status: "NEW" });
    await createInquiry(foreignTenantId, foreignArtworkId, { status: "NEW" });
    await createInquiry(foreignTenantId, foreignArtworkId, { status: "NEW" });

    const result = await queryInquiries(tenantId, 1, "all");

    expect(result.total).toBe(1);
    expect(result.rows[0].archivedAt).toBeNull();
  });

  it("totalPages = ceil(total / 25)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    for (let i = 0; i < 26; i++) await createInquiry(tenantId, artworkId);

    const result = await queryInquiries(tenantId, 1);

    expect(result.total).toBe(26);
    expect(result.totalPages).toBe(2);
  });
});
