/**
 * Background sweep that re-sends buyer confirmation emails for PAID orders
 * whose confirmation was never delivered (emailSentAt IS NULL).
 *
 * Retries are capped (MAX_EMAIL_ATTEMPTS) and exponentially backed off based
 * on emailLastAttemptAt so a permanently bad address doesn't retry forever.
 */
import { db, ordersTable, orderItemsTable, tenantsTable } from "@workspace/db";
import { and, eq, gte, isNull, isNotNull, lt, ne } from "drizzle-orm";
import {
  sendOrderConfirmation,
  sendOrderStatusUpdate,
  sendConfirmationFailureNotice,
} from "@/lib/email";
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
      // Guard the bookkeeping write independently — a DB outage must not
      // crash the whole sweep; the order stays re-selectable for the next run.
      try {
        await db
          .update(ordersTable)
          .set({
            emailError: message,
            emailAttempts: order.emailAttempts + 1,
            emailLastAttemptAt: now,
          })
          .where(eq(ordersTable.id, order.id));
      } catch (dbErr) {
        console.error(
          `Email sweep: could not persist failure state for order ${order.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.failed++;

      // Final attempt just failed — notify the gallery once so they can
      // reach the buyer directly.
      if (
        order.emailAttempts + 1 >= MAX_EMAIL_ATTEMPTS &&
        !order.emailFailureNotifiedAt &&
        tenant.contactEmail
      ) {
        try {
          await sendConfirmationFailureNotice({
            galleryEmail: tenant.contactEmail,
            buyerEmail: order.buyerEmail,
            buyerName: order.buyerName,
            artworkTitle: item.artworkTitle,
            orderRef: order.id.slice(0, 8).toUpperCase(),
            tenantName: tenant.businessName,
            lastError: message,
          });
          await db
            .update(ordersTable)
            .set({ emailFailureNotifiedAt: now })
            .where(eq(ordersTable.id, order.id));
        } catch (noticeErr) {
          // Leave emailFailureNotifiedAt unset; since the order has now
          // exhausted MAX_EMAIL_ATTEMPTS it won't be re-selected, so log
          // loudly for the admin flagging UI to surface.
          console.error(
            `Email sweep: failed to notify gallery about exhausted retries for order ${order.id}:`,
            (noticeErr as any)?.message ?? String(noticeErr),
          );
        }
      }
    }
  }

  return result;
}

/**
 * Retry the gallery failure-notification alert for orders whose buyer
 * confirmation email exhausted all attempts (emailAttempts >= MAX_EMAIL_ATTEMPTS)
 * but whose gallery was never notified (emailFailureNotifiedAt IS NULL).
 *
 * This runs every sweep cycle. Once the alert is delivered successfully,
 * emailFailureNotifiedAt is set and the order is never re-selected.
 */
export async function sweepUnsentGalleryAlerts(
  now: Date = new Date(),
): Promise<SweepResult> {
  const candidates = await db.query.ordersTable.findMany({
    where: and(
      gte(ordersTable.emailAttempts, MAX_EMAIL_ATTEMPTS),
      isNull(ordersTable.emailFailureNotifiedAt),
      isNotNull(ordersTable.buyerEmail),
      ne(ordersTable.buyerEmail, ""),
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
    const [item, tenant] = await Promise.all([
      db.query.orderItemsTable.findFirst({
        where: eq(orderItemsTable.orderId, order.id),
      }),
      db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, order.tenantId),
      }),
    ]);

    if (!item || !tenant?.contactEmail) {
      // No gallery contact address — nothing to send; mark as done so we stop
      // re-selecting this order on every sweep cycle.
      await db
        .update(ordersTable)
        .set({ emailFailureNotifiedAt: now })
        .where(eq(ordersTable.id, order.id));
      result.skipped++;
      continue;
    }

    try {
      await sendConfirmationFailureNotice({
        galleryEmail: tenant.contactEmail,
        buyerEmail: order.buyerEmail,
        buyerName: order.buyerName,
        artworkTitle: item.artworkTitle,
        orderRef: order.id.slice(0, 8).toUpperCase(),
        tenantName: tenant.businessName,
        lastError: order.emailError ?? "Unknown error",
      });
      await db
        .update(ordersTable)
        .set({ emailFailureNotifiedAt: now })
        .where(eq(ordersTable.id, order.id));
      result.sent++;
    } catch (err) {
      // Leave emailFailureNotifiedAt unset — this order will be re-selected
      // on the next sweep run and the send will be retried automatically.
      console.error(
        `Email sweep: gallery alert retry failed for order ${order.id}:`,
        (err as any)?.message ?? String(err),
      );
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
      // Guard the bookkeeping write independently — a DB outage must not
      // crash the whole sweep; the order stays re-selectable for the next run.
      try {
        await db
          .update(ordersTable)
          .set({
            statusEmailError: message,
            statusEmailAttempts: order.statusEmailAttempts + 1,
            statusEmailLastAttemptAt: now,
          })
          .where(eq(ordersTable.id, order.id));
      } catch (dbErr) {
        console.error(
          `Email sweep: could not persist status-email failure state for order ${order.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.failed++;
    }
  }

  return result;
}
