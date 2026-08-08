/** Shared display helpers for the platform admin portal. */

export function formatMoney(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
  });
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Human-readable subscription state, including whether a trial/subscription
 * is current or expired. Complements tenantBillingStatus (which powers the
 * status badge) with the "so what" detail admins asked for.
 */
export function subscriptionDetail(tenant: {
  billingExempt: boolean;
  subscriptionStatus: string | null;
  trialEnd: Date | null;
}): string {
  if (tenant.billingExempt) return "Complimentary — paywall bypassed";
  const s = tenant.subscriptionStatus;
  if (!s) return "Never subscribed";
  if (s === "trialing") {
    if (tenant.trialEnd) {
      const expired = tenant.trialEnd.getTime() < Date.now();
      return expired
        ? `Trial expired ${formatDate(tenant.trialEnd)}`
        : `Trial — ends ${formatDate(tenant.trialEnd)}`;
    }
    return "Trialing";
  }
  if (s === "active") return "Current — paid subscription";
  if (s === "past_due") return "Payment overdue — subscription at risk";
  if (s === "canceled") return "Canceled / expired";
  return s;
}
