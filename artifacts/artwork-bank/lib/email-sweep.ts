/**
 * Background sweep that re-sends buyer confirmation emails for PAID orders
 * whose confirmation was never delivered (emailSentAt IS NULL).
 *
 * Retries are capped (MAX_EMAIL_ATTEMPTS) and exponentially backed off based
 * on emailLastAttemptAt so a permanently bad address doesn't retry forever.
 */
import { db, ordersTable, orderItemsTable, tenantsTable } from "@workspace/db";
import { and, eq, isNull, isNotNull, lt, ne } from "drizzle-orm";
import { sendOrderConfirmation, sendOrderStatusUpdate } from "@/lib/email";
import { getTenantUrl } from "@/lib/base-url";

/** Give up after this many failed attempts (initial send counts as one). */
export const MAX_EMAIL_ATTEMPTS = 5;

/** Base backoff: 5 min, then 10, 20, 40… doubling per prior attempt. */
export const BASE_BACKOFF_MS = 5 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
}

export interface SweepResult {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Find PAID orders with an unsent confirmation email and retry sending.
 * Orders are skipped while still inside their backoff window; orders that
 * have exhausted MAX_EMAIL_ATTEMPTS are never selected.
 */
export async function sweepUnsentConfirmationEmails(
  now: Date = new Date(),
): Promise<SweepResult> {
  const candidates = await db.query.ordersTable.findMany({
    where: and(
      eq(ordersTable.status, "PAID"),
      isNull(ordersTable.emailSentAt),
      isNotNull(ordersTable.buyerEmail),
      ne(ordersTable.buyerEmail, ""),
      lt(ordersTable.emailAttempts, MAX_EMAIL_ATTEMPTS),
    ),
    limit: 50,
  });

  const result: SweepResult = {
    scanned: candidates.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const order of candidates) {
    // Respect exponential backoff since the last attempt.
    if (
      order.emailLastAttemptAt &&
      now.getTime() - order.emailLastAttemptAt.getTime() <
        backoffMs(order.emailAttempts)
    ) {
      result.skipped++;
      continue;
    }

    const [item, tenant] = await Promise.all([
      db.query.orderItemsTable.findFirst({
        where: eq(orderItemsTable.orderId, order.id),
      }),
      db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, order.tenantId),
      }),
    ]);

    if (!item || !tenant) {
      result.skipped++;
      continue;
    }

    try {
      await sendOrderConfirmation({
        buyerEmail: order.buyerEmail,
        buyerName: order.buyerName,
        artworkTitle: item.artworkTitle,
        fulfillmentType: order.fulfillmentType,
        orderRef: order.id.slice(0, 8).toUpperCase(),
        tenantName: tenant.businessName,
        orderLookupUrl: getTenantUrl(tenant, "/orders"),
      });
      await db
        .update(ordersTable)
        .set({
          emailSentAt: now,
          emailError: null,
          emailAttempts: order.emailAttempts + 1,
          emailLastAttemptAt: now,
        })
        .where(eq(ordersTable.id, order.id));
      result.sent++;
    } catch (err) {
      const message = (err as any)?.message ?? String(err);
      console.error(
        `Email sweep: confirmation failed for order ${order.id} (attempt ${order.emailAttempts + 1}/${MAX_EMAIL_ATTEMPTS}):`,
        message,
      );
      await db
        .update(ordersTable)
        .set({
          emailError: message,
          emailAttempts: order.emailAttempts + 1,
          emailLastAttemptAt: now,
        })
        .where(eq(ordersTable.id, order.id));
      result.failed++;
    }
  }

  return result;
}

/**
 * Find orders with a queued (undelivered) buyer status-update email and retry
 * sending. Mirrors the confirmation sweep: exponential backoff via
 * statusEmailLastAttemptAt, capped at MAX_EMAIL_ATTEMPTS.
 */
export async function sweepUnsentStatusEmails(
  now: Date = new Date(),
): Promise<SweepResult> {
  const candidates = await db.query.ordersTable.findMany({
    where: and(
      isNotNull(ordersTable.statusEmailQueuedAt),
      isNotNull(ordersTable.buyerEmail),
      ne(ordersTable.buyerEmail, ""),
      lt(ordersTable.statusEmailAttempts, MAX_EMAIL_ATTEMPTS),
    ),
    limit: 50,
  });

  const result: SweepResult = {
    scanned: candidates.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const order of candidates) {
    if (
      order.statusEmailLastAttemptAt &&
      now.getTime() - order.statusEmailLastAttemptAt.getTime() <
        backoffMs(order.statusEmailAttempts)
    ) {
      result.skipped++;
      continue;
    }

    const [item, tenant] = await Promise.all([
      db.query.orderItemsTable.findFirst({
        where: eq(orderItemsTable.orderId, order.id),
      }),
      db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, order.tenantId),
      }),
    ]);

    if (!item || !tenant) {
      result.skipped++;
      continue;
    }

    try {
      await sendOrderStatusUpdate({
        buyerEmail: order.buyerEmail,
        buyerName: order.buyerName,
        artworkTitle: item.artworkTitle,
        status: order.status,
        trackingNote: order.trackingNote,
        orderRef: order.id.slice(0, 8).toUpperCase(),
        tenantName: tenant.businessName,
        orderLookupUrl: getTenantUrl(tenant, "/orders"),
      });
      await db
        .update(ordersTable)
        .set({
          statusEmailQueuedAt: null,
          statusEmailError: null,
          statusEmailAttempts: order.statusEmailAttempts + 1,
          statusEmailLastAttemptAt: now,
        })
        .where(eq(ordersTable.id, order.id));
      result.sent++;
    } catch (err) {
      const message = (err as any)?.message ?? String(err);
      console.error(
        `Email sweep: status update failed for order ${order.id} (attempt ${order.statusEmailAttempts + 1}/${MAX_EMAIL_ATTEMPTS}):`,
        message,
      );
      await db
        .update(ordersTable)
        .set({
          statusEmailError: message,
          statusEmailAttempts: order.statusEmailAttempts + 1,
          statusEmailLastAttemptAt: now,
        })
        .where(eq(ordersTable.id, order.id));
      result.failed++;
    }
  }

  return result;
}
