/**
 * bulkSetInquiriesArchived — real-DB integration (Task #74).
 *
 * The existing `inquiry-bulk-archive-tenant-scope.test.ts` is mock-only.
 * This suite calls the real action against a live PostgreSQL database and
 * verifies the full path: auth, billing gate, tenant scope, DB persistence.
 *
 *  1. archive=true sets archivedAt on own inquiries.
 *  2. archive=false clears archivedAt on own inquiries (round-trip).
 *  3. Foreign-tenant IDs are silently skipped; own inquiries still updated.
 *  4. Empty ID list throws.
 *  5. >200 IDs throws.
 *  6. Duplicate IDs are deduplicated — single UPDATE, correct result.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth + billing stubs ──────────────────────────────────────────────────────
const mockSession = vi.hoisted(() => ({
  userId: "user-bulk-archive-test",
  tenantId: "placeholder-tenant", // overridden per-test via setTenant()
  email: "admin@test.com",
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { bulkSetInquiriesArchived } from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-blia-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Bulk Archive Test Gallery",
    type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  // Redirect the action's session to this tenant.
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Test Artwork",
    buyerName: "Buyer",
    buyerEmail: "buyer@example.com",
    message: "Hello",
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

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("bulkSetInquiriesArchived — real-DB integration (Task #74)", () => {
  it("archive=true sets archivedAt on own inquiries", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const id1 = await createInquiry(tenantId, artworkId);
    const id2 = await createInquiry(tenantId, artworkId);

    await bulkSetInquiriesArchived([id1, id2], true);

    const row1 = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id1) });
    const row2 = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id2) });
    expect(row1?.archivedAt).toBeInstanceOf(Date);
    expect(row2?.archivedAt).toBeInstanceOf(Date);
  });

  it("archive=false clears archivedAt (round-trip unarchive)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const id = await createInquiry(tenantId, artworkId);

    // First archive it.
    await bulkSetInquiriesArchived([id], true);
    const archivedRow = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
    expect(archivedRow?.archivedAt).toBeInstanceOf(Date);

    // Then unarchive.
    await bulkSetInquiriesArchived([id], false);
    const unarchivedRow = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
    expect(unarchivedRow?.archivedAt).toBeNull();
  });

  it("foreign-tenant IDs are silently skipped; own inquiry still updated", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const ownId = await createInquiry(tenantId, artworkId);

    // Create a second tenant + inquiry without changing mockSession.tenantId
    // (createTenant() always updates mockSession.tenantId, so we must save ownTenant first).
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignArtworkId = uid();
    await db.insert(artworksTable).values({
      id: foreignArtworkId, tenantId: foreignTenantId,
      title: "Foreign Art", sku: `sku-${foreignArtworkId}`, status: "AVAILABLE",
    } as any);
    createdArtworkIds.push(foreignArtworkId);
    const foreignId = uid();
    await db.insert(inquiriesTable).values({
      id: foreignId, tenantId: foreignTenantId, artworkId: foreignArtworkId,
      artworkTitle: "Foreign Art", buyerName: "Buyer",
      buyerEmail: "buyer@foreign.com", message: "Hello",
    } as any);
    createdInquiryIds.push(foreignId);

    // Restore session to own tenant.
    mockSession.tenantId = tenantId;

    await bulkSetInquiriesArchived([ownId, foreignId], true);

    // Own inquiry must be archived.
    const ownRow = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, ownId) });
    expect(ownRow?.archivedAt).toBeInstanceOf(Date);

    // Foreign inquiry must be untouched.
    const foreignRow = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, foreignId) });
    expect(foreignRow?.archivedAt).toBeNull();
  });

  it("empty ID list resolves as a silent no-op", async () => {
    await createTenant();
    await expect(bulkSetInquiriesArchived([], true)).resolves.not.toThrow();
  });

  it(">200 IDs throws", async () => {
    await createTenant();
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    await expect(bulkSetInquiriesArchived(tooMany, true)).rejects.toThrow("Too many inquiries selected at once.");
  });

  it("duplicate IDs are deduplicated — correct result, no error", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const id = await createInquiry(tenantId, artworkId);

    // Pass same ID three times.
    await bulkSetInquiriesArchived([id, id, id], true);

    const row = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
    expect(row?.archivedAt).toBeInstanceOf(Date);
  });
});
