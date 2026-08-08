/**
 * Bulk set inquiries status to HANDLED — real-DB integration.
 *
 * app/(admin)/(gated)/inquiries/actions.ts: bulkSetInquiriesStatus(ids[], "HANDLED").
 * inquiry.status enum = "NEW" | "HANDLED".
 * Tenant isolation: only own-tenant inquiries are updated.
 *
 *  1. Multiple inquiries can be marked HANDLED in one call.
 *  2. Status changes from NEW to HANDLED.
 *  3. Already-HANDLED inquiries remain HANDLED (idempotent).
 *  4. Foreign tenant's inquiries are not touched by own-tenant bulk action.
 *  5. Partially-valid id list — own inquiries are updated, foreign are not.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, inquiriesTable, artworksTable,
  usersTable, tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-ibmhi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-bulk-handled", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { bulkSetInquiriesStatus } from "@/app/(admin)/(gated)/inquiries/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({ id, slug: id, businessName: "Bulk Handled Test", type: "ARTIST" } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Bulk Inquiry Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string, alreadyHandled = false) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    buyerEmail: `buyer-${id}@test.com`, buyerName: "Bulk Buyer",
    artworkTitle: "Bulk Inquiry Art",
    message: "Bulk inquiry message",
    status: alreadyHandled ? "HANDLED" : "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryStatus(id: string) {
  const row = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
  return row?.status ?? null;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Bulk set inquiries status to HANDLED — real-DB integration", () => {
  it("multiple inquiries can be marked HANDLED in one call", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const [id1, id2, id3] = await Promise.all([
      createInquiry(tenantId, artworkId),
      createInquiry(tenantId, artworkId),
      createInquiry(tenantId, artworkId),
    ]);

    await bulkSetInquiriesStatus([id1!, id2!, id3!], "HANDLED");

    expect(await inquiryStatus(id1!)).toBe("HANDLED");
    expect(await inquiryStatus(id2!)).toBe("HANDLED");
    expect(await inquiryStatus(id3!)).toBe("HANDLED");
  });

  it("status changes from NEW to HANDLED", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    expect(await inquiryStatus(inquiryId)).toBe("NEW");

    await bulkSetInquiriesStatus([inquiryId], "HANDLED");

    expect(await inquiryStatus(inquiryId)).toBe("HANDLED");
  });

  it("already-HANDLED inquiries remain HANDLED (idempotent)", async () => {
    const { tenantId } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, true);

    await bulkSetInquiriesStatus([inquiryId], "HANDLED");

    expect(await inquiryStatus(inquiryId)).toBe("HANDLED");
  });

  it("foreign tenant's inquiries are not touched by own-tenant bulk action", async () => {
    const { tenantId: ownTenant }     = await createTenant();
    const { tenantId: foreignTenant } = await createTenant();
    const ownArtwork     = await createArtwork(ownTenant);
    const foreignArtwork = await createArtwork(foreignTenant);
    const ownId     = await createInquiry(ownTenant, ownArtwork);
    const foreignId = await createInquiry(foreignTenant, foreignArtwork);

    mockSession.value = { ...mockSession.value, tenantId: ownTenant };
    await bulkSetInquiriesStatus([ownId, foreignId], "HANDLED");

    expect(await inquiryStatus(ownId)).toBe("HANDLED");
    expect(await inquiryStatus(foreignId)).toBe("NEW"); // untouched
  });

  it("partially-valid id list — own inquiries updated, foreign are not", async () => {
    const { tenantId: ownTenant }     = await createTenant();
    const { tenantId: foreignTenant } = await createTenant();
    const ownArtwork     = await createArtwork(ownTenant);
    const foreignArtwork = await createArtwork(foreignTenant);
    const ownId     = await createInquiry(ownTenant, ownArtwork);
    const foreignId = await createInquiry(foreignTenant, foreignArtwork);

    mockSession.value = { ...mockSession.value, tenantId: ownTenant };
    await bulkSetInquiriesStatus([ownId, foreignId], "HANDLED");

    expect(await inquiryStatus(ownId)).toBe("HANDLED");
    expect(await inquiryStatus(foreignId)).toBe("NEW");
  });
});
