"use server";

import { getSession } from "@/lib/auth";
import { db, inquiriesTable } from "@workspace/db";
import { eq, and, count, isNull, isNotNull, gte } from "drizzle-orm";
import {
  MAX_EMAIL_ATTEMPTS,
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";

/**
 * Returns the number of NEW (unhandled, non-archived) inquiries for the
 * caller's tenant.  Called by the real-time InquiryBadge client component.
 */
export async function getNewInquiryCount(): Promise<number> {
  const session = await getSession();
  if (!session.userId) return 0;

  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, session.tenantId),
        eq(inquiriesTable.status, "NEW"),
        isNull(inquiriesTable.archivedAt),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Returns the number of non-archived inquiries whose notification email has
 * permanently failed (all MAX_EMAIL_ATTEMPTS exhausted) for the caller's
 * tenant.  Drives the warning banner on the Inquiries page.
 * Archived inquiries are excluded so the banner disappears once a lead is
 * resolved.
 */
export async function getEmailFailCount(): Promise<number> {
  const session = await getSession();
  if (!session.userId) return 0;

  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, session.tenantId),
        isNotNull(inquiriesTable.emailError),
        gte(inquiriesTable.emailAttempts, MAX_EMAIL_ATTEMPTS),
        isNull(inquiriesTable.archivedAt),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Returns the number of non-archived inquiries that are stuck in the
 * "claimed-but-never-attempted" state: emailClaimNonce IS NOT NULL AND
 * emailLastAttemptAt IS NULL.  A non-zero count surfaces an admin banner
 * offering a one-click repair via clearStuckInquiryNonces.
 */
export async function getStuckNonceCount(): Promise<number> {
  const session = await getSession();
  if (!session.userId) return 0;

  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, session.tenantId),
        isNotNull(inquiriesTable.emailClaimNonce),
        isNull(inquiriesTable.emailLastAttemptAt),
        isNull(inquiriesTable.archivedAt),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Returns the number of non-archived inquiries that carry the
 * "no gallery contact email" sentinel — i.e. inquiries that could not be
 * delivered because the gallery has no contact email configured.
 *
 * The dashboard shows this count only when the tenant currently has no
 * contact email, so the banner disappears immediately on save even though
 * the sentinel is retained until the next sweep successfully delivers the
 * inquiries.
 */
export async function getNoContactEmailInquiryCount(): Promise<number> {
  const session = await getSession();
  if (!session.userId) return 0;

  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, session.tenantId),
        eq(inquiriesTable.emailError, NO_CONTACT_EMAIL_ERROR),
        isNull(inquiriesTable.archivedAt),
      ),
    );

  return row?.count ?? 0;
}
