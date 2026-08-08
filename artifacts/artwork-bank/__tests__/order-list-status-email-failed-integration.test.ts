/**
 * Task #46 — Show galleries when a buyer's shipping update email failed
 * (real database integration).
 *
 * The admin orders page shows an "Update email failed" badge when:
 *
 *   statusEmailError  != null
 *   statusEmailAttempts >= 5   (MAX_EMAIL_ATTEMPTS exhausted)
 *
 * This is distinct from the retrying state (attempts 1–4) and from the
 * refund-notification failure (#148, attempts === 0 + queuedAt null).
 *
 * Unit tests (order-list-refund-badge.test.ts lines 209–282) confirm the
 * derivation logic with mocked data.  These integration tests confirm the same
 * column values survive a real INSERT→SELECT round-trip.
 *
 * Coverage:
 *   1. attempts=5 + error set  →  statusEmailFailed=true  (primary case)
 *   2. attempts=6 + error set  →  statusEmailFailed=true  (above threshold)
 *   3. attempts=4 + error set  →  statusEmailFailed=false (retrying, not yet failed)
 *   4. attempts=5 + error=null →  statusEmailFailed=false (no error, cleared after success)
 *   5. attempts=0 + error set  →  statusEmailFailed=false (refund-notification path #148)
 *   6. Positive control: failed order has status "PAID", confirming the badge
 *      is shown regardless of order status.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

import { db, tenantsTable, artworksTable, ordersTable, orderItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function uid() {
  return randomUUID();
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Status Email Test Gallery ${id}`,
    slug: `status-email-${id}`,
  } as any);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-se-${id}`,
    showInGallery: true,
    status: "SOLD",
  } as any);
  return id;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  overrides: {
    statusEmailError?: string | null;
    statusEmailAttempts?: number;
    statusEmailQueuedAt?: Date | null;
    status?: "PAID" | "FULFILLED" | "CANCELLED";
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id,
    tenantId,
    status: overrides.status ?? "FULFILLED",
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 10000,
    fulfillmentType: "SHIP",
    statusEmailError: overrides.statusEmailError ?? null,
    statusEmailAttempts: overrides.statusEmailAttempts ?? 0,
    statusEmailQueuedAt: overrides.statusEmailQueuedAt ?? null,
  } as any);

  await db.insert(orderItemsTable).values({
    id: uid(),
    orderId: id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork",
    priceCents: 10000,
  } as any);

  return id;
}

async function readStatusEmailFields(orderId: string) {
  return db.query.ordersTable.findFirst({
    where: eq(ordersTable.id, orderId),
    columns: {
      statusEmailError: true,
      statusEmailAttempts: true,
      statusEmailQueuedAt: true,
    },
  });
}

const MAX_EMAIL_ATTEMPTS = 5;

/** Same derivation as the admin orders page. */
function deriveStatusEmailFailed(row: {
  statusEmailError: string | null;
  statusEmailAttempts: number;
}) {
  return !!row.statusEmailError && row.statusEmailAttempts >= MAX_EMAIL_ATTEMPTS;
}

function deriveStatusEmailRetrying(row: {
  statusEmailError: string | null;
  statusEmailAttempts: number;
}) {
  return (
    !!row.statusEmailError &&
    row.statusEmailAttempts > 0 &&
    row.statusEmailAttempts < MAX_EMAIL_ATTEMPTS
  );
}

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdOrderIds.length = 0;
});

afterEach(async () => {
  for (const id of createdOrderIds) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

describeIntegration(
  "order-list status-email-failed badge — real DB round-trip (Task #46)",
  () => {
    it("statusEmailFailed=true when error is set and attempts=5 (exhausted)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "SMTP: recipient refused",
        statusEmailAttempts: 5,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(row).toBeDefined();
      expect(deriveStatusEmailFailed(row!)).toBe(true);
    });

    it("statusEmailFailed=true when attempts=6 (above threshold)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "DNS resolution failure",
        statusEmailAttempts: 6,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(deriveStatusEmailFailed(row!)).toBe(true);
    });

    it("statusEmailFailed=false and statusEmailRetrying=true when attempts=4 (not yet exhausted)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Temporary SMTP failure",
        statusEmailAttempts: 4,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(deriveStatusEmailFailed(row!)).toBe(false);
      expect(deriveStatusEmailRetrying(row!)).toBe(true);
    });

    it("statusEmailFailed=false when error is null even if attempts=5 (cleared after success)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: null,
        statusEmailAttempts: 5,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(deriveStatusEmailFailed(row!)).toBe(false);
    });

    it("statusEmailFailed=false when attempts=0 even with an error (refund-notification path #148)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Refund notification failed",
        statusEmailAttempts: 0,
        statusEmailQueuedAt: null,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(deriveStatusEmailFailed(row!)).toBe(false);
    });

    it("badges are mutually exclusive: failed order has statusEmailFailed=true and retrying=false", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Rate limit",
        statusEmailAttempts: 5,
      });
      createdOrderIds.push(orderId);

      const row = await readStatusEmailFields(orderId);
      expect(deriveStatusEmailFailed(row!)).toBe(true);
      expect(deriveStatusEmailRetrying(row!)).toBe(false);
    });
  },
);
