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
  contactEmail: z
    .string()
    .email()
    .optional()
    .or(z.literal("")),
});

export async function updateTenantSettings(formData: FormData) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const parsed = settingsSchema.safeParse({
    businessName: formData.get("businessName"),
    themeColor: formData.get("themeColor"),
    aboutText: formData.get("aboutText"),
    contactEmail: formData.get("contactEmail"),
  });
  if (!parsed.success) redirect("/settings?error=invalid");

  await db
    .update(tenantsTable)
    .set({
      businessName: parsed.data.businessName,
      themeColor: parsed.data.themeColor ?? null,
      aboutText: parsed.data.aboutText ?? null,
      contactEmail: parsed.data.contactEmail || null,
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

// ---------------------------------------------------------------------------
// Custom domain management
// ---------------------------------------------------------------------------

const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export async function saveCustomDomain(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const rawDomain = (formData.get("customDomain") as string | null)
    ?.trim()
    .toLowerCase();

  if (!rawDomain) {
    return { error: "Please enter a domain name." };
  }
  if (!DOMAIN_RE.test(rawDomain)) {
    return { error: "That doesn't look like a valid domain. Use the format: www.example.com" };
  }

  // Check the domain isn't already used by a different tenant
  const existing = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.customDomain, rawDomain),
  });
  if (existing && existing.id !== session.tenantId) {
    return { error: "This domain is already in use by another gallery." };
  }

  await db
    .update(tenantsTable)
    .set({ customDomain: rawDomain, customDomainVerified: false })
    .where(eq(tenantsTable.id, session.tenantId));

  redirect("/settings?domain_status=saved");
}

export async function removeCustomDomain() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  await db
    .update(tenantsTable)
    .set({ customDomain: null, customDomainVerified: false })
    .where(eq(tenantsTable.id, session.tenantId));

  redirect("/settings");
}

export async function verifyCustomDomain(): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant?.customDomain) {
    redirect("/settings");
  }

  const cnameTarget = process.env.CNAME_TARGET ?? "cname.i-art.com.au";

  // Dynamic import so the dns module is only loaded server-side
  const dns = await import("node:dns/promises");

  let verified = false;
  try {
    const records = await dns.resolveCname(tenant.customDomain);
    verified = records.some(
      (r) =>
        r.toLowerCase() === cnameTarget.toLowerCase() ||
        r.toLowerCase() === `${cnameTarget.toLowerCase()}.`,
    );
  } catch {
    // DNS resolution failed (NXDOMAIN, ENODATA, etc.)
    verified = false;
  }

  await db
    .update(tenantsTable)
    .set({ customDomainVerified: verified })
    .where(eq(tenantsTable.id, session.tenantId));

  redirect(`/settings?domain_status=${verified ? "verified" : "unverified"}`);
}

// ---------------------------------------------------------------------------
// Stripe Connect onboarding
// ---------------------------------------------------------------------------
export async function startStripeOnboarding() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { getStripeClient } = await import("@/lib/stripe");

  let stripe;
  try {
    stripe = await getStripeClient();
  } catch {
    redirect("/settings?stripe=not_configured");
  }

  // stripe is always defined here (redirect() above never returns)
  const stripeClient = stripe!;

  let accountId = tenant.stripeAccountId;
  if (!accountId) {
    const account = await stripeClient.accounts.create({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      country: "AU",
    });
    accountId = account.id;
    await db
      .update(tenantsTable)
      .set({ stripeAccountId: accountId })
      .where(eq(tenantsTable.id, tenant.id));
  }

  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
  const baseUrl = replitDomain
    ? `https://${replitDomain}`
    : "http://localhost:3000";

  const accountLink = await stripeClient.accountLinks.create({
    account: accountId,
    refresh_url: `${baseUrl}/settings?stripe=refresh`,
    return_url: `${baseUrl}/settings?stripe=connected`,
    type: "account_onboarding",
  });

  redirect(accountLink.url);
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
