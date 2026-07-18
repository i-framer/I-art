"use server";

import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import {
  tenantsTable,
  staffInvitesTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getSession, generateToken } from "@/lib/auth";

const settingsSchema = z.object({
  businessName: z.string().min(2),
  themeColor: z.string().optional(),
  aboutText: z.string().optional(),
});

export async function updateTenantSettings(formData: FormData) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const parsed = settingsSchema.safeParse({
    businessName: formData.get("businessName"),
    themeColor: formData.get("themeColor"),
    aboutText: formData.get("aboutText"),
  });
  if (!parsed.success) redirect("/settings?error=invalid");

  await db
    .update(tenantsTable)
    .set({
      businessName: parsed.data.businessName,
      themeColor: parsed.data.themeColor ?? null,
      aboutText: parsed.data.aboutText ?? null,
    })
    .where(eq(tenantsTable.id, session.tenantId));

  redirect("/settings?saved=1");
}

// ---------------------------------------------------------------------------
// Invite state type
// ---------------------------------------------------------------------------
export type InviteResultState = {
  error: string;
  success: boolean;
  inviteUrl: string;
  email: string;
};

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "staff"]),
});

export async function createInvite(
  _prevState: InviteResultState,
  formData: FormData,
): Promise<InviteResultState> {
  const session = await getSession();
  if (!session.userId) {
    return { error: "Not authenticated.", success: false, inviteUrl: "", email: "" };
  }
  if (session.role !== "owner") {
    return {
      error: "Only owners can invite team members.",
      success: false,
      inviteUrl: "",
      email: "",
    };
  }

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: "Please enter a valid email address.",
      success: false,
      inviteUrl: "",
      email: "",
    };
  }

  const { email, role } = parsed.data;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(staffInvitesTable).values({
    tenantId: session.tenantId,
    email: email.toLowerCase(),
    role,
    token,
    expiresAt,
  });

  return { success: true, inviteUrl: `/invite/${token}`, email, error: "" };
}

export async function removeTeamMember(userId: string) {
  const session = await getSession();
  if (!session.userId) return;
  if (session.role !== "owner") return;
  if (userId === session.userId) return;

  await db
    .delete(tenantUsersTable)
    .where(
      and(
        eq(tenantUsersTable.tenantId, session.tenantId),
        eq(tenantUsersTable.userId, userId),
      ),
    );
}
