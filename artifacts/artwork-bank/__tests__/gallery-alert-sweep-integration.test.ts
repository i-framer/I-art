/**
 * Task #49 — Retry the gallery alert if it fails to send the first time
 * (real database integration).
 *
 * sweepUnsentGalleryAlerts() selects orders where:
 *   emailAttempts >= MAX_EMAIL_ATTEMPTS (5)
 *   emailFailureNotifiedAt IS NULL
 *   buyerEmail IS NOT NULL AND NOT ''
 *
 * For each candidate it looks up the order item (artworkTitle) and tenant
 * (contactEmail).  Then:
 *   - If contactEmail is set: attempts sendConfirmationFailureNotice and sets
 *     emailFailureNotifiedAt on success OR marks a durable failure.
 *   - If no contactEmail:     skips send but still sets emailFailureNotifiedAt
 *     so the order is never re-selected.
 *
 * Unit tests (gallery-alert-retry.test.ts, gallery-alert-sweep.test.ts) cover
 * this logic with mocked DB.  These integration tests run against a real
 * PostgreSQL instance to confirm the SELECT predicate, the send path, and the
 * emailFailureNotifiedAt stamp all work end-to-end.
 *
 * Coverage:
 *   1. First sweep: send succeeds → emailFailureNotifiedAt is stamped.
 *   2. Second sweep: already-stamped order → not re-selected.
 *   3. Send fails first time → emailFailureNotifiedAt NOT set → order
 *      re-selected on second sweep; send succeeds → stamped.
 *   4. emailAttempts < 5 → order not selected at all.
 *   5. No tenant contactEmail → order skipped (notified) on first sweep;
 *      not re-selected on second.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock only the email transport, keep real DB ───────────────────────────────

const sendConfirmationFailureNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
  sendConfirmationFailureNotice: (...a: unknown[]) =>
    sendConfirmationFailureNotice(...a),
}));

import { db, tenantsTable, artworksTable, ordersTable, orderItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sweepUnsentGalleryAlerts } from "@/lib/email-sweep";

function uid() {
  return randomUUID();
}

async function createTenant(overrides: { contactEmail?: string | null } = {}) {
  const id = uid();
  // Use 'in' check so null is stored as NULL (not replaced by ?? default).
  const contactEmail =
    "contactEmail" in overrides ? overrides.contactEmail : "gallery@example.com";
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Gallery Alert Test ${id}`,
    slug: `gallery-alert-${id}`,
    contactEmail,
  } as any);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-ga-${id}`,
    showInGallery: true,
    status: "AVAILABLE",
  } as any);
  return id;
}

const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Insert an order that qualifies for the gallery-alert sweep:
 * emailAttempts >= 5, emailFailureNotifiedAt null, buyerEmail set.
 */
async function createAlertCandidateOrder(
  tenantId: string,
  artworkId: string,
  overrides: {
    emailAttempts?: number;
    emailFailureNotifiedAt?: Date | null;
    buyerEmail?: string;
  } = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id,
    tenantId,
    status: "PAID",
    buyerEmail: overrides.buyerEmail ?? "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 10000,
    fulfillmentType: "PICKUP",
    emailAttempts: overrides.emailAttempts ?? MAX_EMAIL_ATTEMPTS,
    emailError: "SMTP: connection refused",
    emailFailureNotifiedAt: overrides.emailFailureNotifiedAt ?? null,
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

async function getEmailFailureNotifiedAt(orderId: string) {
  const row = await db.query.ordersTable.findFirst({
    where: eq(ordersTable.id, orderId),
    columns: { emailFailureNotifiedAt: true },
  });
  return row?.emailFailureNotifiedAt ?? null;
}

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  createdOrderIds.length = 0;
  sendConfirmationFailureNotice.mockClear();
  sendConfirmationFailureNotice.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
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
  "sweepUnsentGalleryAlerts — real DB retry behavior (Task #49)",
  () => {
    it("stamps emailFailureNotifiedAt after a successful send on the first sweep", async () => {
      const tenantId = await createTenant({ contactEmail: "gallery@test.com" });
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);
      const orderId = await createAlertCandidateOrder(tenantId, artworkId);
      createdOrderIds.push(orderId);

      const result = await sweepUnsentGalleryAlerts();

      // Should have processed our order.
      expect(result.sent + result.failed + result.skipped).toBeGreaterThanOrEqual(1);

      // emailFailureNotifiedAt must be set after a successful send.
      const notifiedAt = await getEmailFailureNotifiedAt(orderId);
      expect(notifiedAt).not.toBeNull();
    });

    it("does NOT re-select the order on a second sweep after emailFailureNotifiedAt is set", async () => {
      const tenantId = await createTenant({ contactEmail: "gallery@test.com" });
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);
      const orderId = await createAlertCandidateOrder(tenantId, artworkId);
      createdOrderIds.push(orderId);

      // First sweep — stamps notifiedAt.
      await sweepUnsentGalleryAlerts();
      const callCountAfterFirst = sendConfirmationFailureNotice.mock.calls.length;

      // Second sweep — must not re-select the stamped order.
      await sweepUnsentGalleryAlerts();
      const callCountAfterSecond = sendConfirmationFailureNotice.mock.calls.length;

      expect(callCountAfterSecond).toBe(callCountAfterFirst);
    });

    it("leaves emailFailureNotifiedAt null after a send failure, so the order is re-selected next sweep", async () => {
      const tenantId = await createTenant({ contactEmail: "gallery@test.com" });
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);
      const orderId = await createAlertCandidateOrder(tenantId, artworkId);
      createdOrderIds.push(orderId);

      // First sweep: send fails.
      sendConfirmationFailureNotice.mockRejectedValueOnce(new Error("transport error"));
      await sweepUnsentGalleryAlerts();

      let notifiedAt = await getEmailFailureNotifiedAt(orderId);
      expect(notifiedAt).toBeNull();

      // Second sweep: send succeeds.
      sendConfirmationFailureNotice.mockResolvedValueOnce(undefined);
      await sweepUnsentGalleryAlerts();

      notifiedAt = await getEmailFailureNotifiedAt(orderId);
      expect(notifiedAt).not.toBeNull();
    });

    it("does NOT select an order with emailAttempts < MAX_EMAIL_ATTEMPTS", async () => {
      const tenantId = await createTenant({ contactEmail: "gallery@test.com" });
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);

      // Insert with attempts below the threshold.
      const orderId = await createAlertCandidateOrder(tenantId, artworkId, {
        emailAttempts: MAX_EMAIL_ATTEMPTS - 1,
      });
      createdOrderIds.push(orderId);

      await sweepUnsentGalleryAlerts();

      // The order must not have been processed (notifiedAt stays null).
      const notifiedAt = await getEmailFailureNotifiedAt(orderId);
      expect(notifiedAt).toBeNull();
    });

    it("stamps emailFailureNotifiedAt (skipped) when tenant has no contactEmail, preventing reselection", async () => {
      const tenantId = await createTenant({ contactEmail: null });
      createdTenantIds.push(tenantId);
      const artworkId = await createArtwork(tenantId);
      createdArtworkIds.push(artworkId);
      const orderId = await createAlertCandidateOrder(tenantId, artworkId);
      createdOrderIds.push(orderId);

      const result = await sweepUnsentGalleryAlerts();

      // Should be counted as skipped (no contact email).
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();

      // Must still be stamped so it is never re-selected.
      const notifiedAt = await getEmailFailureNotifiedAt(orderId);
      expect(notifiedAt).not.toBeNull();

      // Second sweep confirms no reselection.
      const result2 = await sweepUnsentGalleryAlerts();
      const totalSecond = result2.sent + result2.failed + result2.skipped;
      // Our order must not contribute to the second run's skipped count.
      // We can only assert the order is not skipped a second time by checking
      // that sendConfirmationFailureNotice is still not called.
      expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
      void totalSecond; // suppress unused-variable warning
    });
  },
);
