/**
 * setInquiryStatus / setInquiryArchived — real-DB integration.
 *
 * Unit tests cover these actions with mocked DB.  This integration suite
 * verifies the DB persistence and tenant-isolation invariants against real
 * PostgreSQL:
 *
 * setInquiryStatus:
 *  1. Sets status=HANDLED for a NEW inquiry.
 *  2. Sets status=NEW for a HANDLED inquiry (revert).
 *  3. Foreign tenant's inquiryId throws "Inquiry not found." — no DB write.
 *
 * setInquiryArchived:
 *  4. Sets archivedAt to a timestamp when archived=true.
 *  5. Clears archivedAt to NULL when archived=false.
 *  6. Foreign tenant's inquiryId throws — no DB write.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-inq-actions", tenantId: "PLACEHOLDER" };
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

import {
  setInquiryStatus,
  setInquiryArchived,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-ia-${RUN}-${++seq}`;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Inquiry Actions Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
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

async function createInquiry(
  tenantId: string, artworkId: string,
  opts: { status?: "NEW" | "HANDLED"; archivedAt?: Date | null } = {},
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId,
    artworkTitle: "Test",
    buyerName: "Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("setInquiryStatus / setInquiryArchived — real-DB integration", () => {
  // ── setInquiryStatus ───────────────────────────────────────────────────────

  it("setInquiryStatus: sets status=HANDLED for a NEW inquiry", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, { status: "NEW" });

    await setInquiryStatus(fd({ inquiryId, status: "HANDLED" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.status).toBe("HANDLED");
  });

  it("setInquiryStatus: reverts status=NEW for a HANDLED inquiry", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, { status: "HANDLED" });

    await setInquiryStatus(fd({ inquiryId, status: "NEW" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.status).toBe("NEW");
  });

  it("setInquiryStatus: throws for a foreign tenant's inquiryId — row unchanged", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const inquiryId = await createInquiry(tenantA, artworkId, { status: "NEW" });

    const tenantB = await createTenant();
    mockSession.tenantId = tenantB;

    await expect(setInquiryStatus(fd({ inquiryId, status: "HANDLED" }))).rejects.toThrow(
      "Inquiry not found",
    );

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.status).toBe("NEW");
  });

  // ── setInquiryArchived ─────────────────────────────────────────────────────

  it("setInquiryArchived: sets archivedAt to a timestamp when archived=true", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId, { archivedAt: null });

    await setInquiryArchived(fd({ inquiryId, archived: "true" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.archivedAt).not.toBeNull();
  });

  it("setInquiryArchived: clears archivedAt to NULL when archived=false", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const now = new Date();
    const inquiryId = await createInquiry(tenantId, artworkId, { archivedAt: now });

    await setInquiryArchived(fd({ inquiryId, archived: "false" }));

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.archivedAt).toBeNull();
  });

  it("setInquiryArchived: throws for a foreign tenant's inquiryId — archivedAt unchanged", async () => {
    const tenantA = await createTenant();
    const artworkId = await createArtwork(tenantA);
    const inquiryId = await createInquiry(tenantA, artworkId, { archivedAt: null });

    const tenantB = await createTenant();
    mockSession.tenantId = tenantB;

    await expect(setInquiryArchived(fd({ inquiryId, archived: "true" }))).rejects.toThrow(
      "Inquiry not found",
    );

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    expect(row?.archivedAt).toBeNull();
  });
});
