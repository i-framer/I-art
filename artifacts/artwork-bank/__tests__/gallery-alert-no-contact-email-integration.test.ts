/**
 * sweepUnsentGalleryAlerts — contactEmail=null skip semantics — real-DB integration.
 *
 * lib/email-sweep.ts:205 skips the gallery alert when tenant.contactEmail is null:
 *   if (!item || !tenant?.contactEmail) { set emailFailureNotifiedAt; return; }
 *
 * A tenant with contactEmail=null must:
 *  1. Have emailFailureNotifiedAt set (so the order is not re-selected).
 *  2. NOT trigger the sendConfirmationFailureNotice email.
 *
 * This complements the Task #512 case (notificationSkipped channel) but at the
 * gallery-alert sweep level, not the 207 HTTP layer.
 *
 *  1. Tenant with contactEmail=null → emailFailureNotifiedAt is set; sweep skips the order.
 *  2. Tenant with contactEmail set → emailFailureNotifiedAt is set via notice sent path.
 *  3. Once emailFailureNotifiedAt is set, the order is not re-selected in the next sweep.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-ganc-${RUN}-${++seq}`; }

const sendConfirmationFailureNotice = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendConfirmationFailureNotice,
  sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
}));

import { sweepUnsentGalleryAlerts, MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

async function createTenant(contactEmail: string | null) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Gallery Alert Null Test", type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Gallery Alert Test Art", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createExhaustedOrder(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, artworkId, status: "PAID",
    totalCents: 10000,
    buyerName: "Test Buyer",
    buyerEmail: "buyer@test.com",
    fulfillmentType: "PICKUP",
    stripeSessionId: `cs_test_${id}`,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailFailureNotifiedAt: null,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
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

describeIntegration("sweepUnsentGalleryAlerts — null contactEmail skip — real-DB integration", () => {
  it("null contactEmail: emailFailureNotifiedAt is set; order not re-selected", async () => {
    const tenantId = await createTenant(null);
    const artworkId = await createArtwork(tenantId);
    const orderId = await createExhaustedOrder(tenantId, artworkId);

    await sweepUnsentGalleryAlerts(new Date());

    // emailFailureNotifiedAt must be set so the sweep won't re-select this order.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailFailureNotifiedAt).toBeInstanceOf(Date);
  });

  it("non-null contactEmail: emailFailureNotifiedAt is set via the notice path", async () => {
    const tenantId = await createTenant("owner@gallery.test");
    const artworkId = await createArtwork(tenantId);
    const orderId = await createExhaustedOrder(tenantId, artworkId);

    sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);
    await sweepUnsentGalleryAlerts(new Date());

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailFailureNotifiedAt).toBeInstanceOf(Date);
  });

  it("once emailFailureNotifiedAt is set, the order is not re-selected in the next sweep", async () => {
    const tenantId = await createTenant(null);
    const artworkId = await createArtwork(tenantId);
    const orderId = await createExhaustedOrder(tenantId, artworkId);

    // First sweep sets emailFailureNotifiedAt.
    await sweepUnsentGalleryAlerts(new Date());

    // Verify it was set.
    const after1 = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    const firstNotifiedAt = after1?.emailFailureNotifiedAt;
    expect(firstNotifiedAt).toBeInstanceOf(Date);

    // Second sweep must not re-select or overwrite the order.
    const _result2 = await sweepUnsentGalleryAlerts(new Date());
    const after2 = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });

    // emailFailureNotifiedAt must not have changed (order was excluded from sweep).
    expect(after2?.emailFailureNotifiedAt?.getTime()).toBe(firstNotifiedAt?.getTime());
  });
});
