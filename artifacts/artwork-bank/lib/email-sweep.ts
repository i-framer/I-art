/**
 * Background sweep that re-sends buyer confirmation emails for PAID orders
 * whose confirmation was never delivered (emailSentAt IS NULL).
 *
 * Retries are capped (MAX_EMAIL_ATTEMPTS) and exponentially backed off based
 * on emailLastAttemptAt so a permanently bad address doesn't retry forever.
 */
import {
  db,
  ordersTable,
  orderItemsTable,
  tenantsTable,
  inquiriesTable,
  artworksTable,
} from "@workspace/db";
import { and, eq, gte, isNull, isNotNull, lt, ne } from "drizzle-orm";
import {
  sendOrderConfirmation,
  sendOrderStatusUpdate,
  sendConfirmationFailureNotice,
  sendArtworkInquiry,
} from "@/lib/email";
import { getTenantUrl } from "@/lib/base-url";

/** Give up after this many failed attempts (initial send counts as one). */
export const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Sentinel stored in inquiries.emailError when the gallery has no contact
 * email configured.  Exported so the dashboard count query and any other
 * consumers use the same literal and cannot silently drift.
 */
export const NO_CONTACT_EMAIL_ERROR = "no gallery contact email";

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

    // Atomic claim: stamp emailLastAttemptAt while verifying that our snapshot
    // of emailAttempts is still current.  If two concurrent sweeps both read
    // the same row (emailAttempts=N, emailSentAt=null), only one UPDATE wins;
    // the other gets 0 rows and skips, preventing duplicate confirmation sends.
    const [claimed] = await db
      .update(ordersTable)
      .set({ emailLastAttemptAt: now })
      .where(
        and(
          eq(ordersTable.id, order.id),
          eq(ordersTable.emailAttempts, order.emailAttempts),
          isNull(ordersTable.emailSentAt),
        ),
      )
      .returning({ id: ordersTable.id });
    if (!claimed) {
      // Another sweep instance claimed this row — skip without double-sending.
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
 *
 * Concurrency note: unlike the confirmation and status sweeps this function
 * does not add an atomic claim step.  emailFailureNotifiedAt is the only
 * available completion marker (there is no per-attempt counter to use as an
 * optimistic lock), and temporarily setting it to a sentinel would mark the
 * row "done" before the email actually lands.  The worst-case duplicate here
 * is the gallery receiving two "buyer confirmation failed" notices for the
 * same order, which is benign — it cannot result in a buyer receiving a
 * duplicate email, and the alert rate is very low.
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

    // Atomic claim: same pattern as the confirmation sweep.  Stamps
    // statusEmailLastAttemptAt while verifying statusEmailAttempts is
    // unchanged.  A second concurrent sweep will get 0 rows and skip,
    // preventing duplicate status-update emails to the buyer.
    const [claimed] = await db
      .update(ordersTable)
      .set({ statusEmailLastAttemptAt: now })
      .where(
        and(
          eq(ordersTable.id, order.id),
          eq(ordersTable.statusEmailAttempts, order.statusEmailAttempts),
          isNotNull(ordersTable.statusEmailQueuedAt),
        ),
      )
      .returning({ id: ordersTable.id });
    if (!claimed) {
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

/**
 * When a gallery owner adds a contact email via the settings page, reset ALL
 * inquiries for that tenant whose emailError is "no gallery contact email" —
 * regardless of attempt count.  Resetting emailAttempts to 0 and
 * emailLastAttemptAt to null achieves two things:
 *
 *  1. Exhausted rows (emailAttempts ≥ MAX_EMAIL_ATTEMPTS) re-enter the sweep
 *     candidate set because emailAttempts < MAX_EMAIL_ATTEMPTS again.
 *
 *  2. Non-exhausted rows that a concurrent sweep is currently processing get
 *     their snapshot invalidated: the sweep's CAS condition checks
 *     emailAttempts = <snapshot> — after this reset changes emailAttempts to 0,
 *     the stale CAS fails and the row is left at emailAttempts=0, so the next
 *     sweep can deliver it instead of bumping it toward MAX.
 *
 * It is safe to call unconditionally on every settings save — it is a no-op
 * when there are no no-contact-email inquiries for the tenant.
 *
 * ── Decision: SMTP-error inquiries are NOT reset on email change ─────────────
 *
 * Inquiries that exhausted their attempts with an SMTP error (e.g. "550
 * mailbox not found" for the gallery's *old* address) are intentionally left
 * untouched here, even when the gallery owner switches to a different email.
 *
 * Rationale:
 *  • SMTP failures are tied to the *buyer's* address or the mail-server path,
 *    not solely to the gallery's contact email.  A "550 mailbox not found"
 *    reply from the remote MX could mean the buyer's address is invalid; that
 *    would still fail after an email change.
 *  • Silently re-enqueuing SMTP-error rows on every address change would risk
 *    flooding a newly configured address with a burst of old, potentially
 *    un-deliverable notifications.
 *  • The "no gallery contact email" sentinel is the only error that is
 *    *structurally* caused by the gallery's own configuration state and whose
 *    root cause is definitively resolved by adding an address.  Resetting only
 *    that sentinel keeps the requeue semantics narrow and predictable.
 *
 * If a gallery wants to retry SMTP-error inquiries after fixing their email
 * address they can do so explicitly via a future admin action (e.g. "retry all
 * failed inquiries").  The integration tests in
 * tenant-settings-update-integration.test.ts assert this boundary explicitly.
 *
 * @param tenantId  The tenant whose contact email was just set.
 */
export async function requeueNoContactEmailInquiries(
  tenantId: string,
): Promise<void> {
  await db
    .update(inquiriesTable)
    .set({
      emailAttempts: 0,
      emailLastAttemptAt: null,
    })
    .where(
      and(
        eq(inquiriesTable.tenantId, tenantId),
        eq(inquiriesTable.emailError, NO_CONTACT_EMAIL_ERROR),
      ),
    );
}

/**
 * Explicit "retry all failed notifications" escape hatch for gallery owners.
 *
 * Resets emailAttempts to 0 and emailLastAttemptAt to null for ALL inquiries
 * belonging to the tenant that have a non-null emailError — regardless of the
 * error type or current attempt count.  emailError is deliberately preserved
 * so the sweep can distinguish retries from fresh inquiries via the existing
 * `emailError IS NOT NULL` candidate filter.
 *
 * Unlike requeueNoContactEmailInquiries (which is scoped to the
 * "no gallery contact email" sentinel and fires automatically on contact-email
 * save), this function is intentionally manual — it is triggered by the gallery
 * owner via the settings page after they have resolved the underlying issue
 * (e.g. updated their contact email or confirmed the buyer's address).
 *
 * The reset is safe to call multiple times: a row with emailAttempts already
 * at 0 is re-set to 0 (no-op in practice).
 *
 * @param tenantId  The tenant whose failed inquiry notifications should be
 *                  re-enqueued.
 * @returns         The number of inquiry rows that were reset.
 */
export async function requeueAllFailedInquiries(
  tenantId: string,
): Promise<number> {
  const rows = await db
    .update(inquiriesTable)
    .set({
      emailAttempts: 0,
      emailLastAttemptAt: null,
    })
    .where(
      and(
        eq(inquiriesTable.tenantId, tenantId),
        isNotNull(inquiriesTable.emailError),
      ),
    )
    .returning({ id: inquiriesTable.id });
  return rows.length;
}

/**
 * Resets only the inquiries that are counted by the "permanently failed"
 * alert banner on the Inquiries page: non-archived rows whose emailError is
 * set AND whose emailAttempts have reached MAX_EMAIL_ATTEMPTS.
 *
 * This is the narrower counterpart to requeueAllFailedInquiries — it ensures
 * the success-banner count matches the alert-banner count, and never
 * re-queues archived or still-retrying rows.
 *
 * @param tenantId  The tenant whose exhausted inquiry notifications should be
 *                  re-enqueued.
 * @returns         The number of inquiry rows that were reset.
 */
export async function requeueExhaustedInquiries(
  tenantId: string,
): Promise<number> {
  const rows = await db
    .update(inquiriesTable)
    .set({
      emailAttempts: 0,
      emailLastAttemptAt: null,
    })
    .where(
      and(
        eq(inquiriesTable.tenantId, tenantId),
        isNotNull(inquiriesTable.emailError),
        gte(inquiriesTable.emailAttempts, MAX_EMAIL_ATTEMPTS),
        isNull(inquiriesTable.archivedAt),
      ),
    )
    .returning({ id: inquiriesTable.id });
  return rows.length;
}
/**
 * Find inquiries whose notification email to the gallery was never delivered
 * (emailError IS NOT NULL) and retry sending with exponential back-off.
 *
 * Mirrors sweepUnsentConfirmationEmails:
 *  – capped at MAX_EMAIL_ATTEMPTS total attempts
 *  – exponential backoff based on emailLastAttemptAt
 *  – atomic optimistic-lock claim to guard against concurrent sweeps sending
 *    the same notification twice
 *
 * @param now     Reference timestamp for backoff calculations.
 * @param tenantId When provided, restricts the sweep to inquiries belonging to
 *                 a single tenant.  Used by integration tests to prevent the
 *                 global query from touching rows owned by other test runs or
 *                 real tenants in the shared dev database.
 */
export async function sweepUnsentInquiryEmails(
  now: Date = new Date(),
  tenantId?: string,
): Promise<SweepResult> {
  const candidates = await db.query.inquiriesTable.findMany({
    where: and(
      isNotNull(inquiriesTable.emailError),
      lt(inquiriesTable.emailAttempts, MAX_EMAIL_ATTEMPTS),
      tenantId ? eq(inquiriesTable.tenantId, tenantId) : undefined,
    ),
    limit: 50,
  });

  const result: SweepResult = {
    scanned: candidates.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const inquiry of candidates) {
    // Respect exponential backoff since the last attempt.
    if (
      inquiry.emailLastAttemptAt &&
      now.getTime() - inquiry.emailLastAttemptAt.getTime() <
        backoffMs(inquiry.emailAttempts)
    ) {
      result.skipped++;
      continue;
    }

    // Resolve dependencies before claiming.  Checking artwork and tenant here
    // (before the CAS stamp) means a missing artwork or gallery address leaves
    // the inquiry row completely untouched — no emailLastAttemptAt is written,
    // so the row stays eligibly re-selectable and no spurious backoff is
    // applied to a row that was never actually attempted.
    const [artwork, tenant] = await Promise.all([
      db.query.artworksTable.findFirst({
        where: eq(artworksTable.id, inquiry.artworkId),
      }),
      db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, inquiry.tenantId),
      }),
    ]);

    // When the artwork no longer exists (deleted after the inquiry was
    // recorded) there is nothing useful to retry — the gallery email would
    // always reference a phantom artwork.  Write a terminal error and bump
    // emailAttempts to MAX_EMAIL_ATTEMPTS so the row is excluded from every
    // future scan.  The CAS claim has NOT been taken yet, so we update
    // unconditionally on the inquiry id.
    if (!artwork) {
      try {
        await db
          .update(inquiriesTable)
          .set({
            emailError: "artwork deleted",
            emailAttempts: MAX_EMAIL_ATTEMPTS,
            emailLastAttemptAt: now,
          })
          .where(eq(inquiriesTable.id, inquiry.id));
      } catch (dbErr) {
        console.error(
          `Inquiry email sweep: could not persist artwork-deleted state for inquiry ${inquiry.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.skipped++;
      continue;
    }

    // Guard against cross-tenant data integrity bugs: the artwork record
    // exists but belongs to a different tenant than the inquiry (e.g. after a
    // botched migration).  Sending would route the notification to the wrong
    // gallery.  The mismatch is permanent — it will never self-heal — so write
    // a terminal error and bump emailAttempts to MAX_EMAIL_ATTEMPTS exactly as
    // the artwork-deleted path does.  This prevents the row from accumulating
    // stale re-scans on every future sweep run.
    if (artwork.tenantId !== inquiry.tenantId) {
      try {
        await db
          .update(inquiriesTable)
          .set({
            emailError: "cross-tenant artwork mismatch",
            emailAttempts: MAX_EMAIL_ATTEMPTS,
            emailLastAttemptAt: now,
          })
          .where(eq(inquiriesTable.id, inquiry.id));
      } catch (dbErr) {
        console.error(
          `Inquiry email sweep: could not persist cross-tenant state for inquiry ${inquiry.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.skipped++;
      continue;
    }

    if (!tenant?.contactEmail) {
      // The gallery has no contact email configured.  Unlike a deleted artwork,
      // this is potentially recoverable — the owner could add an email later.
      // Rather than leaving the row completely untouched (which would cause it
      // to be scanned and skipped on every single sweep run indefinitely), we
      // write a distinct error message and bump emailAttempts by 1 so that
      // normal exponential back-off applies and the row eventually reaches
      // MAX_EMAIL_ATTEMPTS and falls out of the candidate set.
      //
      // Recovery path: when the gallery owner saves a contact email via the
      // settings page, updateTenantSettings calls requeueNoContactEmailInquiries
      // which resets emailAttempts to 0 (keeping emailError non-null so this
      // sweep re-selects the row) for any exhausted inquiry with this error.
      //
      // CAS guard: include the snapshot emailAttempts and a non-null emailError
      // check so a stale write cannot overwrite a concurrent successful delivery
      // (which clears emailError) or a concurrent bump of emailAttempts.
      try {
        await db
          .update(inquiriesTable)
          .set({
            emailError: NO_CONTACT_EMAIL_ERROR,
            emailAttempts: inquiry.emailAttempts + 1,
            emailLastAttemptAt: now,
          })
          .where(
            and(
              eq(inquiriesTable.id, inquiry.id),
              isNotNull(inquiriesTable.emailError),
              eq(inquiriesTable.emailAttempts, inquiry.emailAttempts),
            ),
          );
      } catch (dbErr) {
        console.error(
          `Inquiry email sweep: could not persist no-contact-email state for inquiry ${inquiry.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.skipped++;
      continue;
    }

    // True compare-and-swap claim: stamp emailLastAttemptAt to `now` only
    // if the DB still shows the exact snapshot value we read.  Because the
    // stamp changes emailLastAttemptAt, a second concurrent sweep reading the
    // same row will find a different value in the DB and get 0 rows back,
    // preventing it from proceeding to delivery.
    const [claimed] = await db
      .update(inquiriesTable)
      .set({ emailLastAttemptAt: now })
      .where(
        and(
          eq(inquiriesTable.id, inquiry.id),
          isNotNull(inquiriesTable.emailError),
          // CAS pivot: the prior emailLastAttemptAt must still match.
          inquiry.emailLastAttemptAt
            ? eq(inquiriesTable.emailLastAttemptAt, inquiry.emailLastAttemptAt)
            : isNull(inquiriesTable.emailLastAttemptAt),
        ),
      )
      .returning({ id: inquiriesTable.id });
    if (!claimed) {
      result.skipped++;
      continue;
    }

    const artworkUrl =
      getTenantUrl(tenant, `/${inquiry.artworkId}`) ??
      `/t/${tenant.slug}/${inquiry.artworkId}`;

    try {
      const sent = await sendArtworkInquiry({
        galleryEmail: tenant.contactEmail,
        buyerName: inquiry.buyerName,
        buyerEmail: inquiry.buyerEmail,
        message: inquiry.message,
        artworkTitle: inquiry.artworkTitle,
        artworkSku: artwork.sku,
        artworkUrl,
        tenantName: tenant.businessName,
      });

      if (!sent) {
        throw new Error("Email transport returned false");
      }

      await db
        .update(inquiriesTable)
        .set({
          emailError: null,
          emailAttempts: inquiry.emailAttempts + 1,
          emailLastAttemptAt: now,
        })
        .where(eq(inquiriesTable.id, inquiry.id));
      result.sent++;
    } catch (err) {
      const message = (err as any)?.message ?? String(err);
      console.error(
        `Inquiry email sweep: failed for inquiry ${inquiry.id} (attempt ${inquiry.emailAttempts + 1}/${MAX_EMAIL_ATTEMPTS}):`,
        message,
      );
      // Guard the bookkeeping write independently — a DB outage must not
      // crash the whole sweep; the inquiry stays re-selectable for the next run.
      try {
        await db
          .update(inquiriesTable)
          .set({
            emailError: message,
            emailAttempts: inquiry.emailAttempts + 1,
            emailLastAttemptAt: now,
          })
          .where(eq(inquiriesTable.id, inquiry.id));
      } catch (dbErr) {
        console.error(
          `Inquiry email sweep: could not persist failure state for inquiry ${inquiry.id}:`,
          (dbErr as any)?.message ?? String(dbErr),
        );
      }
      result.failed++;
    }
  }

  return result;
}
