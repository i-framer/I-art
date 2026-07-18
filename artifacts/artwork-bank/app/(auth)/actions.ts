"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { db } from "@workspace/db";
import {
  usersTable,
  tenantsTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, verifyPassword, slugify, getSession } from "@/lib/auth";
import { sessionOptions, type SessionData } from "@/lib/session";

// ---------------------------------------------------------------------------
// Shared state type used by useActionState on the client
// ---------------------------------------------------------------------------
export type AuthState = { error: string };

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  businessName: z.string().min(2),
  type: z.enum(["ARTIST", "FRAMER"]),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function login(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const raw = {
    email: formData.get("email"),
    password: formData.get("password"),
  };
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "Please enter a valid email and password." };
  }

  const { email, password } = parsed.data;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email.toLowerCase()),
  });
  if (!user) {
    return { error: "Invalid email or password." };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { error: "Invalid email or password." };
  }

  const tenantUser = await db.query.tenantUsersTable.findFirst({
    where: eq(tenantUsersTable.userId, user.id),
  });
  if (!tenantUser) {
    return { error: "No account found. Please register." };
  }

  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  session.userId = user.id;
  session.tenantId = tenantUser.tenantId;
  session.role = tenantUser.role as "owner" | "staff";
  session.email = user.email;
  await session.save();

  redirect("/dashboard");
}

export async function register(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const raw = {
    businessName: formData.get("businessName"),
    type: formData.get("type"),
    email: formData.get("email"),
    password: formData.get("password"),
  };
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    return { error: firstError?.message ?? "Invalid input." };
  }

  const { businessName, type, email, password } = parsed.data;

  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email.toLowerCase()),
  });
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  let slug = slugify(businessName);
  if (!slug) slug = "tenant";

  const slugExists = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, slug),
  });
  if (slugExists) {
    const suffix = Math.random().toString(36).slice(2, 6);
    slug = `${slug}-${suffix}`;
  }

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ businessName, type, slug })
    .returning();
  if (!tenant) {
    return { error: "Failed to create account. Please try again." };
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({ email: email.toLowerCase(), passwordHash })
    .returning();
  if (!user) {
    return { error: "Failed to create account. Please try again." };
  }

  await db.insert(tenantUsersTable).values({
    tenantId: tenant.id,
    userId: user.id,
    role: "owner",
  });

  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  session.userId = user.id;
  session.tenantId = tenant.id;
  session.role = "owner";
  session.email = user.email;
  await session.save();

  redirect("/dashboard");
}

export async function logout() {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}
