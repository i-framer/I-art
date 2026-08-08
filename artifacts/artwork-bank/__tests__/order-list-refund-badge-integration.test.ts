/**
 * Task #148 — Show galleries when a buyer's partial refund notification
 * failed to send (real database integration).
 *
 * When `notifyBuyerOfPartialRefund` fails it writes statusEmailError but does
 * NOT increment statusEmailAttempts (stays 0) and does NOT set
 * statusEmailQueuedAt.  The admin orders page derives `refundNotifFailed` from
 * exactly those three conditions:
 *
 *   statusEmailError  != null
 *   statusEmailAttempts === 0
 *   statusEmailQueuedAt is null
 *
 * Unit tests (order-list-refund-badge.test.ts) confirm the derivation logic
 * with mocked data.  These integration tests confirm the same conditions
 * survive a real INSERT→SELECT round-trip so schema drift or column-name
 * mismatches cannot silently break the badge.
 *
 * Coverage:
 *   1. An order with the exact refund-failure pattern produces refundNotifFailed=true.
 *   2. statusEmailAttempts=1 (retry-attempt path) does NOT produce refundNotifFailed.
 *   3. statusEmailAttempts=5 (exhausted, #46 path) does NOT produce refundNotifFailed.
 *   4. statusEmailError=null does NOT produce refundNotifFailed.
 *   5. statusEmailQueuedAt non-null does NOT produce refundNotifFailed (email is queued, not failed).
 *   6. Positive control: order with refundedAmountCents>0 and refund failure → isPartialRefund + refundNotifFailed.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

import { db, tenantsTable, artworksTable, ordersTable, orderItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function uid() {
  return randomUUID();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Refund Badge Test Gallery ${id}`,
    slug: `refund-badge-${id}`,
  } as any);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-rfb-${id}`,
    showInGallery: true,
    status: "AVAILABLE",
  } as any);
  return id;
}

/**
 * Insert a PAID order with customisable status-email and refund fields.
 * Defaults mimic a successful delivery (no errors, no refund).
 */
async function createOrder(
  tenantId: string,
  artworkId: string,
  overrides: {
    statusEmailError?: string | null;
    statusEmailAttempts?: number;
    statusEmailQueuedAt?: Date | null;
    refundedAmountCents?: number | null;
    status?: "PAID" | "FULFILLED" | "CANCELLED";
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id,
    tenantId,
    status: overrides.status ?? "PAID",
    buyerEmail: "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
    // Status-email columns
    statusEmailError: overrides.statusEmailError ?? null,
    statusEmailAttempts: overrides.statusEmailAttempts ?? 0,
    statusEmailQueuedAt: overrides.statusEmailQueuedAt ?? null,
    // Refund columns
    refundedAmountCents: overrides.refundedAmountCents ?? null,
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

/**
 * Read back the badge-relevant columns for one order, replicating the
 * projection the admin orders page SELECT uses.
 */
async function readOrderBadgeFields(orderId: string) {
  return db.query.ordersTable.findFirst({
    where: eq(ordersTable.id, orderId),
    columns: {
      statusEmailError: true,
      statusEmailAttempts: true,
      statusEmailQueuedAt: true,
      refundedAmountCents: true,
      status: true,
    },
  });
}

/** Apply the same badge-derivation logic the admin orders page uses. */
function deriveRefundNotifFailed(row: {
  statusEmailError: string | null;
  statusEmailAttempts: number;
  statusEmailQueuedAt: Date | null;
}) {
  return (
    !!row.statusEmailError &&
    row.statusEmailAttempts === 0 &&
    !row.statusEmailQueuedAt
  );
}

function deriveIsPartialRefund(row: {
  refundedAmountCents: number | null;
  status: string;
}) {
  return (row.refundedAmountCents ?? 0) > 0 && row.status !== "CANCELLED";
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "order-list refund badge — real DB round-trip (Task #148)",
  () => {
    it("refundNotifFailed is true when statusEmailError is set and attempts=0 and queuedAt=null", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "SMTP connection refused",
        statusEmailAttempts: 0,
        statusEmailQueuedAt: null,
        refundedAmountCents: 5000,
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      expect(row).toBeDefined();
      expect(deriveRefundNotifFailed(row!)).toBe(true);
    });

    it("refundNotifFailed + isPartialRefund are both true for a genuine partial-refund notification failure", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Resend: invalid_api_key",
        statusEmailAttempts: 0,
        statusEmailQueuedAt: null,
        refundedAmountCents: 3000,
        status: "PAID",
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      expect(deriveRefundNotifFailed(row!)).toBe(true);
      expect(deriveIsPartialRefund(row!)).toBe(true);
    });

    it("refundNotifFailed is false when statusEmailAttempts=1 (retry-attempt path, not refund-failure)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "SMTP timeout",
        statusEmailAttempts: 1,
        statusEmailQueuedAt: null,
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      // attempts=1 → this is the #46 retrying path, not the #148 refund-failure path
      expect(deriveRefundNotifFailed(row!)).toBe(false);
    });

    it("refundNotifFailed is false when statusEmailAttempts=5 (exhausted, the #46 badge instead)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Rate limit exceeded",
        statusEmailAttempts: 5,
        statusEmailQueuedAt: null,
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      expect(deriveRefundNotifFailed(row!)).toBe(false);
    });

    it("refundNotifFailed is false when statusEmailError is null (no failure)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: null,
        statusEmailAttempts: 0,
        statusEmailQueuedAt: null,
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      expect(deriveRefundNotifFailed(row!)).toBe(false);
    });

    it("refundNotifFailed is false when statusEmailQueuedAt is non-null (email is queued, not failed)", async () => {
      const tenantId = await createTenant();
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      const orderId = await createOrder(tenantId, artworkId, {
        statusEmailError: "Temporary failure",
        statusEmailAttempts: 0,
        statusEmailQueuedAt: new Date(),
      });
      createdOrderIds.push(orderId);

      const row = await readOrderBadgeFields(orderId);
      // queuedAt is set → this is a pending retry, not a refund-notification failure
      expect(deriveRefundNotifFailed(row!)).toBe(false);
    });
  },
);
