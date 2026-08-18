"use server";
import { requireActiveBillingAccess } from "@/lib/billing";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  db,
  inquiriesTable,
  inquiryRepliesTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { sendInquiryReply, EmailSendError } from "@/lib/email";
import { requeueExhaustedInquiries, clearStuckNonces } from "@/lib/email-sweep";

// ---------------------------------------------------------------------------
// Inquiry detail query — scoped to the authenticated tenant
// ---------------------------------------------------------------------------

/**
 * Fetches a single inquiry record visible to the currently authenticated
 * tenant.  The WHERE clause includes BOTH the inquiryId AND the session
 * tenantId so that a cross-tenant caller receives undefined even when the
 * ID is valid.
 *
 * Returns `undefined` when the inquiry is not found or belongs to another
 * tenant.  Redirects to /login when the session is unauthenticated.
 */
export async function getInquiryDetail(inquiryId: string) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  return db.query.inquiriesTable.findFirst({
    where: and(
      eq(inquiriesTable.id, inquiryId),
      eq(inquiriesTable.tenantId, session.tenantId),
    ),
  });
}

// ---------------------------------------------------------------------------
// Inquiry reply-list query — scoped to the authenticated tenant
// ---------------------------------------------------------------------------

/**
 * Fetches reply rows for the given inquiry IDs, scoped to the currently
 * authenticated tenant.  The WHERE clause includes BOTH the tenantId AND
 * the supplied inquiry IDs so that a cross-tenant caller receives an empty
 * array even when they know the inquiry IDs.
 *
 * Returns `[]` when `inquiryIds` is empty or when the session is
 * unauthenticated.
 */
export async function getInquiryReplies(inquiryIds: string[]) {
  if (inquiryIds.length === 0) return [];
  const session = await getSession();
  if (!session.userId) redirect("/login");

  return db
    .select({
      id: inquiryRepliesTable.id,
      inquiryId: inquiryRepliesTable.inquiryId,
      message: inquiryRepliesTable.message,
      sentAt: inquiryRepliesTable.sentAt,
      senderEmail: usersTable.email,
    })
    .from(inquiryRepliesTable)
    .leftJoin(usersTable, eq(inquiryRepliesTable.sentByUserId, usersTable.id))
    .where(
      and(
        eq(inquiryRepliesTable.tenantId, session.tenantId),
        inArray(inquiryRepliesTable.inquiryId, inquiryIds),
      ),
    )
    .orderBy(asc(inquiryRepliesTable.sentAt));
}

export async function setInquiryStatus(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  const inquiryId = formData.get("inquiryId") as string;
  const status = formData.get("status") as string;
  if (!inquiryId || (status !== "NEW" && status !== "HANDLED")) {
    throw new Error("Invalid request.");
  }

  const result = await db
    .update(inquiriesTable)
    .set({ status })
    .where(
      and(
        eq(inquiriesTable.id, inquiryId),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    )
    .returning({ id: inquiriesTable.id });
  if (result.length === 0) throw new Error("Inquiry not found.");

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
}

export async function setInquiryArchived(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  const inquiryId = formData.get("inquiryId") as string;
  const archived = formData.get("archived") as string;
  if (!inquiryId || (archived !== "true" && archived !== "false")) {
    throw new Error("Invalid request.");
  }

  const result = await db
    .update(inquiriesTable)
    .set({ archivedAt: archived === "true" ? new Date() : null })
    .where(
      and(
        eq(inquiriesTable.id, inquiryId),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    )
    .returning({ id: inquiriesTable.id });
  if (result.length === 0) throw new Error("Inquiry not found.");

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
}

export async function bulkSetInquiriesArchived(
  inquiryIds: string[],
  archived: boolean,
): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  const ids = Array.from(
    new Set(inquiryIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) {
    return;
  }
  if (ids.length > 200) {
    throw new Error("Too many inquiries selected at once.");
  }

  await db
    .update(inquiriesTable)
    .set({ archivedAt: archived ? new Date() : null })
    .where(
      and(
        inArray(inquiriesTable.id, ids),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    );

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
}

export async function bulkSetInquiriesStatus(
  inquiryIds: string[],
  status: "NEW" | "HANDLED",
): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  if (status !== "NEW" && status !== "HANDLED") {
    throw new Error("Invalid request.");
  }

  const ids = Array.from(
    new Set(inquiryIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) {
    return;
  }
  if (ids.length > 200) {
    throw new Error("Too many inquiries selected at once.");
  }

  await db
    .update(inquiriesTable)
    .set({ status })
    .where(
      and(
        inArray(inquiriesTable.id, ids),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    );

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
}

export type ReplyState = {
  status: "idle" | "sent" | "sent_not_saved" | "error";
  message?: string;
};

export async function replyToInquiry(
  _prev: ReplyState,
  formData: FormData,
): Promise<ReplyState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  const inquiryId = formData.get("inquiryId") as string;
  const replyMessage = ((formData.get("replyMessage") as string) ?? "").trim();

  if (!inquiryId) {
    return { status: "error", message: "Invalid request." };
  }
  if (!replyMessage) {
    return { status: "error", message: "Reply message cannot be empty." };
  }
  if (replyMessage.length > 5000) {
    return {
      status: "error",
      message: "Reply is too long (5,000 character limit).",
    };
  }

  const [inquiry, tenant] = await Promise.all([
    db.query.inquiriesTable.findFirst({
      where: and(
        eq(inquiriesTable.id, inquiryId),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    }),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
  ]);
  if (!inquiry || !tenant) {
    return { status: "error", message: "Inquiry not found." };
  }

  try {
    await sendInquiryReply({
      buyerEmail: inquiry.buyerEmail,
      buyerName: inquiry.buyerName,
      replyMessage,
      originalMessage: inquiry.message,
      artworkTitle: inquiry.artworkTitle,
      tenantName: tenant.businessName,
      galleryEmail: tenant.contactEmail,
    });
  } catch (err) {
    const message =
      err instanceof EmailSendError
        ? err.message
        : "Failed to send reply. Please try again.";
    return { status: "error", message };
  }

  // Email was sent — now persist the reply record.  If the DB write fails the
  // buyer already received the reply, so we log the error and return a warning
  // rather than pretending success or hiding the problem.
  try {
    await db.insert(inquiryRepliesTable).values({
      tenantId: session.tenantId,
      inquiryId,
      sentByUserId: session.userId,
      message: replyMessage,
    });
  } catch (err) {
    console.error(
      "[inquiry reply] Email sent but DB record failed — tenantId=%s inquiryId=%s error=%s",
      session.tenantId,
      inquiryId,
      (err as any)?.message ?? String(err),
    );
    return {
      status: "sent_not_saved",
      message:
        "Reply was sent to the buyer but could not be saved to the conversation history. Please note this reply manually.",
    };
  }

  await db
    .update(inquiriesTable)
    .set({ status: "HANDLED" })
    .where(
      and(
        eq(inquiriesTable.id, inquiryId),
        eq(inquiriesTable.tenantId, session.tenantId),
      ),
    );

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
  return { status: "sent" };
}

// ---------------------------------------------------------------------------
// Clear stuck-nonce inquiries (crashed-worker repair)
// ---------------------------------------------------------------------------

/**
 * Clears emailClaimNonce on any inquiry that is stuck in the
 * "claimed-but-never-attempted" state (emailClaimNonce IS NOT NULL AND
 * emailLastAttemptAt IS NULL).  Redirects to
 * /inquiries?stuck_result=<count> on success, or ?stuck_result=error on
 * failure.
 */
export async function clearStuckInquiryNonces(): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  let cleared = 0;
  try {
    cleared = await clearStuckNonces(session.tenantId);
  } catch (err) {
    console.error(
      `Inquiries: failed to clear stuck nonces for tenant ${session.tenantId}:`,
      (err as any)?.message ?? String(err),
    );
    redirect("/inquiries?stuck_result=error");
  }

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
  redirect(`/inquiries?stuck_result=${cleared}`);
}

// ---------------------------------------------------------------------------
// Retry failed inquiry notifications (from the inquiries panel)
// ---------------------------------------------------------------------------

/**
 * Resets ALL inquiries for the authenticated tenant that have a non-null
 * emailError, re-enqueuing them for the next sweep cycle.  Redirects to
 * /inquiries?retry_result=<count> on success, or ?retry_result=error on
 * failure.
 */
export async function retryFailedInquiryNotifications(): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  await requireActiveBillingAccess(session.tenantId);

  let retried = 0;
  try {
    retried = await requeueExhaustedInquiries(session.tenantId);
  } catch (err) {
    console.error(
      `Inquiries: failed to retry inquiry notifications for tenant ${session.tenantId}:`,
      (err as any)?.message ?? String(err),
    );
    redirect("/inquiries?retry_result=error");
  }

  revalidatePath("/inquiries");
  revalidatePath("/", "layout");
  redirect(`/inquiries?retry_result=${retried}`);
}
