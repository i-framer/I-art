"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import { requirePlatformAdmin } from "@/lib/platform-admin";

/**
 * Toggle a tenant's billing_exempt flag (comp/uncomp an account).
 * Platform-owner only — tenant admins must never reach this.
 */
export async function setBillingExempt(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const tenantId = formData.get("tenantId");
  const exempt = formData.get("exempt");
  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("Missing tenantId");
  }
  if (exempt !== "true" && exempt !== "false") {
    throw new Error("Missing exempt value");
  }

  const result = await db
    .update(tenantsTable)
    .set({ billingExempt: exempt === "true" })
    .where(eq(tenantsTable.id, tenantId))
    .returning({ id: tenantsTable.id });

  if (result.length === 0) {
    throw new Error("Tenant not found");
  }

  revalidatePath("/platform");
}
