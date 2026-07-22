import { getSession } from "@/lib/auth";

/**
 * Platform-owner access control.
 *
 * The platform owner (the person operating the whole marketplace, not a
 * tenant admin) is identified by email: PLATFORM_ADMIN_EMAILS is a
 * comma-separated allowlist. If the env var is unset or empty, NOBODY is a
 * platform admin — access fails closed.
 */
export function getPlatformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return getPlatformAdminEmails().includes(email.trim().toLowerCase());
}

/**
 * Server-side guard for platform-owner-only actions. Throws unless the
 * current session belongs to a platform admin. Tenant admins/owners are
 * NOT platform admins unless their email is explicitly allowlisted.
 */
export async function requirePlatformAdmin(): Promise<void> {
  const session = await getSession();
  if (!session.userId || !isPlatformAdmin(session.email)) {
    throw new Error("Platform admin access required");
  }
}

/** Display status for a tenant on the platform admin page. */
export function tenantBillingStatus(tenant: {
  billingExempt: boolean;
  subscriptionStatus: string | null;
}): string {
  if (tenant.billingExempt) return "exempt";
  return tenant.subscriptionStatus ?? "none";
}
