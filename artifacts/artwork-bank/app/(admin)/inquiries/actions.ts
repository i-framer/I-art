"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, inquiriesTable, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { sendInquiryReply, EmailSendError } from "@/lib/email";

export async function setInquiryStatus(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");

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

export type ReplyState = {
  status: "idle" | "sent" | "error";
  message?: string;
};

export async function replyToInquiry(
  _prev: ReplyState,
  formData: FormData,
): Promise<ReplyState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");

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
