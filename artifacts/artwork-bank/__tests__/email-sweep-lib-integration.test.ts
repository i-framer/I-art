/**
 * email-sweep lib — real-DB integration.
 *
 * Calls the three sweep functions directly against real PostgreSQL so we
 * verify selector queries, backoff logic, and DB writes — independent of
 * the HTTP route wrapper.
 *
 * Email sending is mocked; all other side-effects (DB reads/writes) are real.
 *
 *  sweepUnsentConfirmationEmails:
 *   1. PAID order with no emailSentAt → swept; emailSentAt set.
 *   2. Email failure → emailAttempts incremented; emailSentAt stays NULL.
 *   3. Order inside backoff window → skipped.
 *   4. Order at MAX_EMAIL_ATTEMPTS → not selected.
 *   5. Non-PAID order → not selected.
 *   6. Already-sent order (emailSentAt set) → not selected.
 *
 *  sweepUnsentGalleryAlerts:
 *   7. Order at MAX_EMAIL_ATTEMPTS with no gallery notify → notified; flag set.
 *   8. No gallery contactEmail → skipped; emailFailureNotifiedAt set.
 *   9. Already notified → not selected.
 *
 *  sweepUnsentStatusEmails:
 *  10. Queued status email → swept; statusEmailQueuedAt cleared.
 *  11. Status email failure → statusEmailAttempts incremented; queue stays.
 *  12. Already at MAX_EMAIL_ATTEMPTS for status → not selected.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Email — controlled per-test ───────────────────────────────────────────────
const sendOrderConfirmation = vi.hoisted(() => vi.fn(async () => {}));
const sendOrderStatusUpdate = vi.hoisted(() => vi.fn(async () => {}));
const sendConfirmationFailureNotice = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendOrderConfirmation, sendOrderStatusUpdate, sendConfirmationFailureNotice };
});
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn().mockReturnValue("https://gallery.test/orders"),
}));

import {
  sweepUnsentConfirmationEmails,
  sweepUnsentGalleryAlerts,
  sweepUnsentStatusEmails,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-esw-${RUN}-${++seq}`; }

async function createTenant(contactEmail: string | null = "owner@gallery.test") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Sweep Test Gallery",
    type: "ARTIST", billingExempt: true,
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Sweep Artwork", sku: `sku-${id}`, status: "SOLD",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

interface OrderOpts {
  status?: string;
  emailSentAt?: Date | null;
  emailAttempts?: number;
  emailLastAttemptAt?: Date | null;
  emailFailureNotifiedAt?: Date | null;
  statusEmailQueuedAt?: Date | null;
  statusEmailAttempts?: number;
  statusEmailLastAttemptAt?: Date | null;
  buyerEmail?: string;
}

async function createOrder(
  tenantId: string,
  artworkId: string,
  opts: OrderOpts = {},
) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail: opts.buyerEmail ?? "buyer@example.com",
    buyerName: "Test Buyer",
    totalCents: 5000,
    status: opts.status ?? "PAID",
    fulfillmentType: "PICKUP",
    emailSentAt: opts.emailSentAt ?? null,
    emailAttempts: opts.emailAttempts ?? 0,
    emailLastAttemptAt: opts.emailLastAttemptAt ?? null,
    emailFailureNotifiedAt: opts.emailFailureNotifiedAt ?? null,
    statusEmailQueuedAt: opts.statusEmailQueuedAt ?? null,
    statusEmailAttempts: opts.statusEmailAttempts ?? 0,
    statusEmailLastAttemptAt: opts.statusEmailLastAttemptAt ?? null,
  } as any);
  await db.insert(orderItemsTable).values({
    id: uid(), orderId: id, artworkId, tenantId,
    artworkTitle: "Sweep Artwork", priceCents: 5000,
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  sendOrderConfirmation.mockReset();
  sendOrderStatusUpdate.mockReset();
  sendConfirmationFailureNotice.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("sweepUnsentConfirmationEmails — real-DB integration", () => {
  it("PAID order with no emailSentAt → email sent; emailSentAt set", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    const result = await sweepUnsentConfirmationEmails(new Date());

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(sendOrderConfirmation).toHaveBeenCalled();

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailSentAt).toBeInstanceOf(Date);
    expect(row?.emailAttempts).toBe(1);
  });

  it("email failure → emailAttempts incremented; emailSentAt stays NULL", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId);

    sendOrderConfirmation.mockRejectedValue(new Error("SMTP timeout"));

    const result = await sweepUnsentConfirmationEmails(new Date());

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailSentAt).toBeNull();
    expect(row?.emailAttempts).toBe(1);
    expect(row?.emailError).toMatch(/SMTP timeout/);
  });

  it("order inside backoff window → skipped (order state unchanged)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const recentAttempt = new Date(); // now = inside 5-min window for 1 prior attempt
    const orderId = await createOrder(tenantId, artworkId, {
      emailAttempts: 1,
      emailLastAttemptAt: recentAttempt,
    });

    await sweepUnsentConfirmationEmails(new Date());

    // The ORDER must be untouched — it was inside the backoff window.
    // (Other orders in the DB from parallel suites may still be swept;
    // we only assert on our specific order.)
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailSentAt).toBeNull(); // unchanged
    expect(row?.emailAttempts).toBe(1); // not incremented
  });

  it("order at MAX_EMAIL_ATTEMPTS → our order state unchanged", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    await sweepUnsentConfirmationEmails(new Date());

    // Our exhausted order must not be incremented further.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS); // unchanged
    expect(row?.emailSentAt).toBeNull(); // never sent
  });

  it("non-PAID order → our order state unchanged (not selected)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, { status: "PENDING" });

    await sweepUnsentConfirmationEmails(new Date());

    // PENDING orders must not be touched.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailAttempts).toBe(0); // unchanged
    expect(row?.emailSentAt).toBeNull();
  });

  it("already-sent order → our order state unchanged (not re-sent)", async () => {
    const sentAt = new Date(Date.now() - 60_000);
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      emailSentAt: sentAt,
    });

    await sweepUnsentConfirmationEmails(new Date());

    // emailSentAt must remain the original value — not cleared or updated.
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailAttempts).toBe(0); // unchanged
    expect(row?.emailSentAt?.getTime()).toBeCloseTo(sentAt.getTime(), -3);
  });
});

describeIntegration("sweepUnsentGalleryAlerts — real-DB integration", () => {
  it("exhausted order with gallery contactEmail → failure notice sent; flag set", async () => {
    const tenantId = await createTenant("owner@gallery.test");
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    const now = new Date();
    const result = await sweepUnsentGalleryAlerts(now);

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(sendConfirmationFailureNotice).toHaveBeenCalled();

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailFailureNotifiedAt).toBeInstanceOf(Date);
  });

  it("no gallery contactEmail → skipped; emailFailureNotifiedAt set to suppress re-selection", async () => {
    const tenantId = await createTenant(null); // no contactEmail
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    const result = await sweepUnsentGalleryAlerts(new Date());

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.emailFailureNotifiedAt).toBeInstanceOf(Date); // suppressed
  });

  it("already notified → not selected", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    await createOrder(tenantId, artworkId, {
      emailAttempts: MAX_EMAIL_ATTEMPTS,
      emailFailureNotifiedAt: new Date(Date.now() - 60_000),
    });

    await sweepUnsentGalleryAlerts(new Date());

    expect(sendConfirmationFailureNotice).not.toHaveBeenCalled();
  });
});

describeIntegration("sweepUnsentStatusEmails — real-DB integration", () => {
  it("queued status email → sent; statusEmailQueuedAt cleared", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      status: "FULFILLED",
      emailSentAt: new Date(), // confirmation was sent
      statusEmailQueuedAt: new Date(Date.now() - 60_000),
    });

    const result = await sweepUnsentStatusEmails(new Date());

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(sendOrderStatusUpdate).toHaveBeenCalled();

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).toBeNull();
    expect(row?.statusEmailAttempts).toBe(1);
  });

  it("status email failure → statusEmailAttempts incremented; queue stays", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      status: "FULFILLED",
      emailSentAt: new Date(),
      statusEmailQueuedAt: new Date(Date.now() - 60_000),
    });

    sendOrderStatusUpdate.mockRejectedValue(new Error("SMTP down"));

    const result = await sweepUnsentStatusEmails(new Date());

    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailQueuedAt).not.toBeNull(); // still queued
    expect(row?.statusEmailAttempts).toBe(1);
    expect(row?.statusEmailError).toMatch(/SMTP down/);
  });

  it("status email at MAX_EMAIL_ATTEMPTS → our order state unchanged", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, artworkId, {
      status: "FULFILLED",
      emailSentAt: new Date(),
      statusEmailQueuedAt: new Date(Date.now() - 60_000),
      statusEmailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    await sweepUnsentStatusEmails(new Date());

    // Our exhausted order must not be incremented further.
    // (Other orders from parallel suites may still be swept; we only
    // assert on our specific order's state.)
    const row = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
    expect(row?.statusEmailAttempts).toBe(MAX_EMAIL_ATTEMPTS); // unchanged
  });
});
