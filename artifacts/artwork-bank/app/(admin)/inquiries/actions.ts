"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, inquiriesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

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
}
