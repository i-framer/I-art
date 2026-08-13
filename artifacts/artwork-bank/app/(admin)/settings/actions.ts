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
  location: z.string().max(120).optional(),
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
    location: formData.get("location") ?? undefined,
    contactEmail: formData.get("contactEmail"),
  });
  if (!parsed.success) redirect("/settings?error=invalid");

  await db
    .update(tenantsTable)
    .set({
      businessName: parsed.data.businessName,
      themeColor: parsed.data.themeColor ?? null,
      aboutText: parsed.data.aboutText ?? null,
      location: parsed.data.location?.trim() || null,
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

  const { getCnameTarget } = await import("@/lib/tenant-cache");
  const cnameTarget = getCnameTarget();
  if (!cnameTarget) {
    // No CNAME target can be resolved — verification cannot succeed.
    redirect("/settings?domain_status=no_cname_target");
  }

  // Dynamic import so the dns module is only loaded server-side
  const dns = await import("node:dns/promises");

  let verified = false;
  let conflict = false;
  try {
    const records = await dns.resolveCname(tenant.customDomain);
    const matchesUs = records.some(
      (r) =>
        r.toLowerCase() === cnameTarget.toLowerCase() ||
        r.toLowerCase() === `${cnameTarget.toLowerCase()}.`,
    );
    if (matchesUs) {
      verified = true;
    } else if (records.length > 0) {
      // CNAME exists but points to a different host — conflict, not just pending.
      conflict = true;
    }
  } catch {
    // DNS resolution failed (NXDOMAIN, ENODATA, etc.) — treat as unverified.
  }

  await db
    .update(tenantsTable)
    .set({ customDomainVerified: verified })
    .where(eq(tenantsTable.id, session.tenantId));

  if (verified) {
    // Auto-provision the domain on Vercel so TLS works without a manual
    // dashboard step. Failures are logged and never block verification.
    const { provisionVercelDomain } = await import("@/lib/vercel-domains");
    await provisionVercelDomain(tenant.customDomain);
  }

  const status = verified ? "verified" : conflict ? "conflict" : "unverified";
  redirect(`/settings?domain_status=${status}`);
}

// ---------------------------------------------------------------------------
// Stripe Connect onboarding
// ---------------------------------------------------------------------------

/**
 * True when a Stripe error means a saved account/customer ID no longer exists
 * under the current API key (e.g. the key was switched between live and test
 * mode, or between Stripe accounts). Recoverable by clearing the stale ID.
 */
function isStripeResourceMissing(err: unknown): boolean {
  const e = err as {
    code?: string;
    raw?: { code?: string };
    message?: string;
  } | null;
  const code = e?.code ?? e?.raw?.code;
  if (code === "resource_missing" || code === "account_invalid") return true;
  return /no such (account|customer)/i.test(String(e?.message ?? ""));
}

/**
 * True when Stripe rejected account creation because Connect is not enabled
 * on the platform account. Not recoverable in-app — the operator must enable
 * Connect in the Stripe dashboard.
 */
function isStripeConnectNotEnabled(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? "");
  return /connect/i.test(msg) && /(signed up|not.*enabled|platform)/i.test(msg);
}

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

  const baseUrl = getBillingBaseUrl();
  const linkParams = (account: string) => ({
    account,
    refresh_url: `${baseUrl}/settings?stripe=refresh`,
    return_url: `${baseUrl}/settings?stripe=connected`,
    type: "account_onboarding" as const,
  });

  const createFreshAccount = async (): Promise<string> => {
    const account = await stripeClient.accounts.create({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      country: "AU",
    });
    await db
      .update(tenantsTable)
      .set({ stripeAccountId: account.id })
      .where(eq(tenantsTable.id, tenant.id));
    return account.id;
  };

  // Collected outside the try/catch so we never swallow NEXT_REDIRECT.
  let onboardingUrl: string | null = null;
  let errorState: string | null = null;

  try {
    let accountId = tenant.stripeAccountId;
    if (!accountId) {
      accountId = await createFreshAccount();
    }

    try {
      const accountLink = await stripeClient.accountLinks.create(
        linkParams(accountId),
      );
      onboardingUrl = accountLink.url;
    } catch (linkErr) {
      // Saved account ID may be stale (created under a different Stripe
      // mode/account). Clear it, create a fresh account, and retry once.
      if (tenant.stripeAccountId && isStripeResourceMissing(linkErr)) {
        console.warn(
          `[stripe-onboarding] Stale Stripe account ${tenant.stripeAccountId} for tenant ${tenant.id} — clearing and recreating.`,
        );
        await db
          .update(tenantsTable)
          .set({ stripeAccountId: null })
          .where(eq(tenantsTable.id, tenant.id));
        const freshId = await createFreshAccount();
        const accountLink = await stripeClient.accountLinks.create(
          linkParams(freshId),
        );
        onboardingUrl = accountLink.url;
      } else {
        throw linkErr;
      }
    }
  } catch (err) {
    console.error(
      `[stripe-onboarding] Stripe error for tenant ${tenant.id}:`,
      err,
    );
    errorState = isStripeConnectNotEnabled(err)
      ? "connect_not_enabled"
      : "rejected";
  }

  if (errorState) redirect(`/settings?stripe=${errorState}`);
  redirect(onboardingUrl!);
}

// ── Platform subscription billing ─────────────────────────────────────────────

function getBillingBaseUrl(): string {
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    (replitDomain ? `https://${replitDomain}` : "http://localhost:3000")
  );
}

export async function startSubscriptionCheckout() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { getStripeClient } = await import("@/lib/stripe");
  const { getSubscriptionPriceId } = await import("@/lib/billing");

  let stripe;
  try {
    stripe = await getStripeClient();
  } catch {
    redirect("/settings/billing?billing=not_configured");
  }
  const stripeClient = stripe!;

  const createFreshCustomer = async (): Promise<string> => {
    const customer = await stripeClient.customers.create({
      name: tenant.businessName,
      ...(tenant.contactEmail ? { email: tenant.contactEmail } : {}),
      metadata: { tenantId: tenant.id },
    });
    await db
      .update(tenantsTable)
      .set({ stripeCustomerId: customer.id })
      .where(eq(tenantsTable.id, tenant.id));
    return customer.id;
  };

  // Collected outside the try/catch so we never swallow NEXT_REDIRECT.
  let checkoutUrl: string | null = null;
  let errorState: string | null = null;

  try {
    // Reuse (or create) the tenant's platform Stripe customer
    let customerId = tenant.stripeCustomerId ?? (await createFreshCustomer());

    const priceId = await getSubscriptionPriceId(stripeClient);
    const baseUrl = getBillingBaseUrl();

    const checkoutParams = (customer: string) => ({
      mode: "subscription" as const,
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/settings/billing?billing=subscribed`,
      cancel_url: `${baseUrl}/settings/billing?billing=cancelled`,
      metadata: { billingTenantId: tenant.id },
      subscription_data: {
        metadata: { billingTenantId: tenant.id },
        // 30-day free trial for all new subscriptions — no charge until day 31.
        trial_period_days: 30,
      },
    });

    try {
      const checkout = await stripeClient.checkout.sessions.create(
        checkoutParams(customerId),
      );
      checkoutUrl = checkout.url!;
    } catch (checkoutErr) {
      // Saved customer ID may be stale (created under a different Stripe
      // mode/account). Clear it, create a fresh customer, and retry once.
      if (tenant.stripeCustomerId && isStripeResourceMissing(checkoutErr)) {
        console.warn(
          `[billing] Stale Stripe customer ${tenant.stripeCustomerId} for tenant ${tenant.id} — clearing and recreating.`,
        );
        await db
          .update(tenantsTable)
          .set({ stripeCustomerId: null })
          .where(eq(tenantsTable.id, tenant.id));
        customerId = await createFreshCustomer();
        const checkout = await stripeClient.checkout.sessions.create(
          checkoutParams(customerId),
        );
        checkoutUrl = checkout.url!;
      } else {
        throw checkoutErr;
      }
    }
  } catch (err) {
    console.error(`[billing] Stripe checkout error for tenant ${tenant.id}:`, err);
    errorState = "stripe_error";
  }

  if (errorState) redirect(`/settings/billing?billing=${errorState}`);
  redirect(checkoutUrl!);
}

export async function openBillingPortal() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant?.stripeCustomerId) redirect("/settings/billing");

  const { getStripeClient } = await import("@/lib/stripe");

  let stripe;
  try {
    stripe = await getStripeClient();
  } catch {
    redirect("/settings/billing?billing=not_configured");
  }

  // Collected outside the try/catch so we never swallow NEXT_REDIRECT.
  let portalUrl: string | null = null;
  let errorState: string | null = null;

  try {
    const portal = await stripe!.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: `${getBillingBaseUrl()}/settings/billing`,
    });
    portalUrl = portal.url;
  } catch (err) {
    if (isStripeResourceMissing(err)) {
      // The saved customer no longer exists under the current Stripe key
      // (mode/account switch). Clear it so the tenant can subscribe afresh.
      console.warn(
        `[billing] Stale Stripe customer ${tenant.stripeCustomerId} for tenant ${tenant.id} — clearing.`,
      );
      await db
        .update(tenantsTable)
        .set({ stripeCustomerId: null })
        .where(eq(tenantsTable.id, tenant.id));
      errorState = "customer_reset";
    } else {
      console.error(`[billing] Stripe portal error for tenant ${tenant.id}:`, err);
      errorState = "stripe_error";
    }
  }

  if (errorState) redirect(`/settings/billing?billing=${errorState}`);
  redirect(portalUrl!);
}

// ── i-Framer Premium self-service verification ────────────────────────────────

/**
 * Self-service i-Framer Premium verification.
 *
 * Security:
 *  - Requires an authenticated tenant admin session.
 *  - Rate-limited to 5 attempts per hour per tenant (in-memory, resets on restart).
 *  - URL input is normalised and validated — only alphanumeric slugs reach the DB.
 *  - Each i-Framer account can be linked to at most one tenant.
 *  - i-Framer DB credentials never leave server code.
 */
export async function verifyIFramerAccount(formData: FormData) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { checkVerifyRateLimit } = await import("@/lib/iframer-rate-limit");
  if (!checkVerifyRateLimit(session.tenantId)) {
    redirect("/settings/billing?iframer=rate_limited");
  }

  const rawUrl = (formData.get("iframerPortalUrl") as string | null)?.trim() ?? "";
  if (!rawUrl) redirect("/settings/billing?iframer=invalid_url");

  const { normaliseIFramerUrl, verifyIFramerPremium, isIFramerVerifyConfigured } =
    await import("@/lib/iframer-verify");

  if (!isIFramerVerifyConfigured()) {
    redirect("/settings/billing?iframer=not_configured");
  }

  const accountId = normaliseIFramerUrl(rawUrl);
  if (!accountId) redirect("/settings/billing?iframer=invalid_url");

  // Enforce one-tenant-per-i-Framer-account: check if this accountId is already
  // linked to a different tenant.
  const existing = await db.query.tenantsTable.findFirst({
    where: (t, { eq: eqOp, ne }) =>
      // Using raw SQL because drizzle doesn't support AND(col=X, col!=Y) via helpers elegantly
      and(eq(t.iframerAccountId, accountId), ne(t.id, session.tenantId)),
    columns: { id: true },
  });
  if (existing) {
    redirect("/settings/billing?iframer=already_linked");
  }

  let result;
  try {
    result = await verifyIFramerPremium(accountId);
  } catch (err) {
    console.error("[iframer-verify] DB query failed:", err);
    redirect("/settings/billing?iframer=db_error");
  }

  if (!result.configured) {
    redirect("/settings/billing?iframer=not_configured");
  }

  if (!result.isPremiumActive) {
    // Encode the failure reason in the URL (short key, not the full message which could be long)
    redirect("/settings/billing?iframer=not_premium");
  }

  // Verification succeeded — grant i-Framer Premium benefits
  // commissionBasisPoints: 350 = 3.5%
  await db
    .update(tenantsTable)
    .set({
      iframerAccountId: accountId,
      iframerPortalUrl: rawUrl,
      iframerVerifiedAt: new Date(),
      billingExempt: true,
      commissionBasisPoints: 350,
    })
    .where(eq(tenantsTable.id, session.tenantId));

  redirect("/settings/billing?iframer=verified");
}

/**
 * Re-verify a previously linked i-Framer account (called on billing page visits
 * when the last verification is stale).  Runs silently — revokes benefits if
 * the subscription has lapsed.
 *
 * @returns "still_active" | "revoked" | "skipped" (not due for re-check) | "unconfigured"
 */
export async function recheckIFramerVerification(
  tenantId: string,
  accountId: string | null | undefined,
  verifiedAt: Date | null | undefined,
): Promise<"still_active" | "revoked" | "skipped" | "unconfigured"> {
  const { isIFramerVerifyConfigured } = await import("@/lib/iframer-verify");
  if (!isIFramerVerifyConfigured()) return "unconfigured";
  if (!accountId) return "skipped";

  // Re-check every 24 hours
  const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  if (verifiedAt && Date.now() - verifiedAt.getTime() < RECHECK_INTERVAL_MS) {
    return "skipped";
  }

  const { verifyIFramerPremium } = await import("@/lib/iframer-verify");
  let result;
  try {
    result = await verifyIFramerPremium(accountId);
  } catch {
    return "skipped"; // Non-fatal — don't revoke on transient DB errors
  }

  if (!result.configured) return "unconfigured";

  if (result.isPremiumActive) {
    // Refresh the verification timestamp
    await db
      .update(tenantsTable)
      .set({ iframerVerifiedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));
    return "still_active";
  }

  // Subscription lapsed — revoke exemption and restore standard commission
  await db
    .update(tenantsTable)
    .set({
      billingExempt: false,
      iframerVerifiedAt: null,
      commissionBasisPoints: null,
    })
    .where(eq(tenantsTable.id, tenantId));
  return "revoked";
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
