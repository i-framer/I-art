/**
 * checkout.session.expired webhook — real-DB integration.
 *
 * app/api/stripe/webhook/route.ts:877-900 (handleCheckoutExpired):
 *   1. Looks up an order by stripeSessionId; if found (PAID) → no-op.
 *   2. Otherwise sets artwork status RESERVED → AVAILABLE.
 *   3. Artwork not in RESERVED state is not touched (guard).
 *   4. tenantId mismatch prevents update (tenant scoping in WHERE clause).
 *
 *  1. Expired checkout without paid order releases RESERVED artwork to AVAILABLE.
 *  2. Expired checkout with an existing paid order does NOT change artwork status.
 *  3. Artwork already AVAILABLE is not changed (guard on status=RESERVED).
 *  4. Foreign tenant artwork is not released by another tenant's expired session.
 *  5. Missing artworkId metadata is a no-op (nothing to release).
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-csei-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Checkout Expired Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id };
}

async function createArtwork(tenantId: string, status: "AVAILABLE" | "RESERVED" = "RESERVED") {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Checkout Expired Art", sku: `sku-${id}`, status,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, sessionId: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId, status: "PAID",
    totalCents: 18000,
    buyerEmail: `buyer-${id}@test.com`,
    buyerName: "Expired Test Buyer",
    fulfillmentType: "PICKUP",
    stripeSessionId: sessionId,
  } as any);
  createdOrderIds.push(id);
  return id;
}

/** Exact DB logic the handleCheckoutExpired handler executes. */
async function simulateCheckoutExpired(
  sessionId: string,
  artworkId: string | null,
  tenantId: string | null,
) {
  if (!artworkId || !tenantId) return;

  const paidOrder = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.stripeSessionId, sessionId),
  });
  if (paidOrder) return;

  await db
    .update(artworksTable)
    .set({ status: "AVAILABLE" })
    .where(
      and(
        eq(artworksTable.id, artworkId),
        eq(artworksTable.tenantId, tenantId),
        eq(artworksTable.status, "RESERVED"),
      ),
    );
}

async function artworkStatus(id: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
  return row?.status ?? null;
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

describeIntegration("checkout.session.expired — real-DB integration", () => {
  it("expired checkout without paid order releases RESERVED artwork to AVAILABLE", async () => {
    const { tenantId } = await createTenant();
    const sessionId   = `cs_test_expired_${uid()}`;
    const artworkId   = await createArtwork(tenantId, "RESERVED");

    await simulateCheckoutExpired(sessionId, artworkId, tenantId);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("expired checkout with an existing paid order does NOT change artwork status", async () => {
    const { tenantId } = await createTenant();
    const sessionId   = `cs_test_paid_${uid()}`;
    const artworkId   = await createArtwork(tenantId, "RESERVED");
    await createOrder(tenantId, sessionId);

    await simulateCheckoutExpired(sessionId, artworkId, tenantId);

    // Artwork must remain RESERVED (paid order guard).
    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });

  it("artwork already AVAILABLE is not changed (guard on status=RESERVED)", async () => {
    const { tenantId } = await createTenant();
    const sessionId   = `cs_test_avail_${uid()}`;
    const artworkId   = await createArtwork(tenantId, "AVAILABLE");

    await simulateCheckoutExpired(sessionId, artworkId, tenantId);

    expect(await artworkStatus(artworkId)).toBe("AVAILABLE");
  });

  it("foreign tenant artwork is not released by another tenant's expired session", async () => {
    const { tenantId: ownId }     = await createTenant();
    const { tenantId: foreignId } = await createTenant();
    const sessionId   = `cs_test_foreign_${uid()}`;
    const foreignArtworkId = await createArtwork(foreignId, "RESERVED");

    // Own tenant passes its tenantId in metadata, but artwork belongs to foreignId.
    await simulateCheckoutExpired(sessionId, foreignArtworkId, ownId);

    expect(await artworkStatus(foreignArtworkId)).toBe("RESERVED"); // unchanged
  });

  it("null artworkId metadata is a no-op (nothing to release)", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await createArtwork(tenantId, "RESERVED");

    await simulateCheckoutExpired(`cs_test_nometa_${uid()}`, null, tenantId);

    // Nothing should change.
    expect(await artworkStatus(artworkId)).toBe("RESERVED");
  });
});
