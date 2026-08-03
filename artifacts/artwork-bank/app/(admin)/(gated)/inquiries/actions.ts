"use server";
import { requireActiveBillingAccess } from "@/lib/billing";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  db,
  inquiriesTable,
  inquiryRepliesTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { sendInquiryReply, EmailSendError } from "@/lib/email";

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
    throw new Error("No inquiries selected.");
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
    throw new Error("No inquiries selected.");
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
