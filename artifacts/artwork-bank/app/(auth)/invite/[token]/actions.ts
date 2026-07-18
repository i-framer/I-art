"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { db } from "@workspace/db";
import {
  usersTable,
  tenantUsersTable,
  staffInvitesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { sessionOptions, type SessionData } from "@/lib/session";

export type InviteState = { error: string };

const acceptSchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function acceptInvite(
  _prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const raw = {
    token: formData.get("token"),
    email: formData.get("email"),
    password: formData.get("password"),
  };
  const parsed = acceptSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "Invalid input." };
  }

  const { token, email, password } = parsed.data;

  const invite = await db.query.staffInvitesTable.findFirst({
    where: eq(staffInvitesTable.token, token),
  });

  if (!invite) {
    return { error: "Invalid or expired invite link." };
  }
  if (invite.acceptedAt) {
    return { error: "This invite has already been used." };
  }
  if (invite.expiresAt < new Date()) {
    return { error: "This invite has expired." };
  }
  if (invite.email.toLowerCase() !== email.toLowerCase()) {
    return { error: "This invite was sent to a different email address." };
  }

  let user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email.toLowerCase()),
  });

  if (user) {
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return { error: "Incorrect password for existing account." };
    }
  } else {
    const passwordHash = await hashPassword(password);
    const [newUser] = await db
      .insert(usersTable)
      .values({ email: email.toLowerCase(), passwordHash })
      .returning();
    if (!newUser) {
      return { error: "Failed to create account. Please try again." };
    }
    user = newUser;
  }

  const existing = await db.query.tenantUsersTable.findFirst({
    where: and(
      eq(tenantUsersTable.tenantId, invite.tenantId),
      eq(tenantUsersTable.userId, user.id),
    ),
  });

  if (!existing) {
    await db.insert(tenantUsersTable).values({
      tenantId: invite.tenantId,
      userId: user.id,
      role: invite.role,
    });
  }

  await db
    .update(staffInvitesTable)
    .set({ acceptedAt: new Date() })
    .where(eq(staffInvitesTable.id, invite.id));

  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  session.userId = user.id;
  session.tenantId = invite.tenantId;
  session.role = invite.role as "owner" | "staff";
  session.email = user.email;
  await session.save();

  redirect("/dashboard");
}
