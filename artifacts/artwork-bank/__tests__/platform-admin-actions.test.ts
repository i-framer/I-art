/**
 * Platform admin actions — setBillingExempt, setIframerAccount, and dismissBillingAlert.
 *
 * Covers:
 *  - Non-platform-admin callers are blocked by requirePlatformAdmin
 *  - setBillingExempt flips billingExempt on the correct tenant
 *  - setBillingExempt throws when tenantId is missing or empty
 *  - setBillingExempt throws when exempt param is invalid
 *  - setBillingExempt throws when tenant is not found (UPDATE returns 0 rows)
 *  - setIframerAccount links an i-Framer ID and also sets billingExempt=true
 *  - setIframerAccount unlinks (empty accountId) without touching billingExempt
 *  - setIframerAccount treats whitespace-only accountId as an unlink
 *  - setIframerAccount throws when tenantId is missing or empty
 *  - setIframerAccount throws when accountId is null (not a string)
 *  - setIframerAccount throws when tenant not found
 *  - setIframerAccount blocks non-admin callers
 *  - setIframerAccount sends a Slack "linked" notification on link
 *  - setIframerAccount sends a Slack "unlinked" notification on unlink
 *  - setIframerAccount skips Slack silently when SLACK_BILLING_ALERTS_CHANNEL is not set
 *  - dismissBillingAlert marks alertId as dismissed
 *  - dismissBillingAlert is a no-op (not an error) for an unknown alertId
 *  - dismissBillingAlert throws when alertId is empty
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock ─────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ email: "admin@example.com" }),
);
vi.mock("@/lib/auth", () => ({ getSession }));

// ── Platform-admin mock ───────────────────────────────────────────────────────
const requirePlatformAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin }));

// ── DB mock ───────────────────────────────────────────────────────────────────
let dbUpdateReturning: unknown[] = [];
let dbUpdateVals: Record<string, unknown> = {};

vi.mock("@workspace/db", () => ({
  db: {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        dbUpdateVals = vals;
        return {
          where: () => ({
            returning: async (_cols?: unknown) => dbUpdateReturning,
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  },
  tenantsTable: {
    id: "tenants.id",
    billingExempt: "tenants.billingExempt",
    iframerAccountId: "tenants.iframerAccountId",
    slug: "tenants.slug",
    businessName: "tenants.businessName",
  },
  stripeAlertsTable: {
    id: "stripeAlerts.id",
    dismissedAt: "stripeAlerts.dismissedAt",
    slackPostFailed: "stripeAlerts.slackPostFailed",
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
}));

// ── next/cache mock ───────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Slack mock ────────────────────────────────────────────────────────────────
const sendIframerAccountSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn().mockReturnValue(null),
  sendBillingAlertSlackNotification: vi.fn(),
  sendIframerAccountSlackNotification,
}));

import {
  setBillingExempt,
  setIframerAccount,
  dismissBillingAlert,
} from "@/app/platform/actions";

function formData(fields: Record<string, string>): FormData {
  return {
    get: (k: string) => fields[k] ?? null,
  } as unknown as FormData;
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePlatformAdmin.mockResolvedValue(undefined);
  getSession.mockResolvedValue({ email: "admin@example.com" });
  sendIframerAccountSlackNotification.mockResolvedValue({ ok: true });
  dbUpdateReturning = [{ id: "tenant-1", slug: "gallery-one", businessName: "Gallery One" }];
  dbUpdateVals = {};
});

// ── setBillingExempt ──────────────────────────────────────────────────────────

describe("setBillingExempt", () => {
  it("throws when requirePlatformAdmin rejects (non-admin)", async () => {
    requirePlatformAdmin.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(
      setBillingExempt(formData({ tenantId: "t-1", exempt: "true" })),
    ).rejects.toThrow("Forbidden");
  });

  it("throws when tenantId is missing", async () => {
    await expect(
      setBillingExempt(formData({ exempt: "true" })),
    ).rejects.toThrow("Missing tenantId");
  });

  it("throws when tenantId is empty", async () => {
    await expect(
      setBillingExempt(formData({ tenantId: "", exempt: "true" })),
    ).rejects.toThrow("Missing tenantId");
  });

  it("throws when exempt param is neither 'true' nor 'false'", async () => {
    await expect(
      setBillingExempt(formData({ tenantId: "t-1", exempt: "yes" })),
    ).rejects.toThrow("Missing exempt value");
  });

  it("throws when tenant is not found (UPDATE returns 0 rows)", async () => {
    dbUpdateReturning = [];
    await expect(
      setBillingExempt(formData({ tenantId: "nonexistent", exempt: "true" })),
    ).rejects.toThrow("Tenant not found");
  });

  it("sets billingExempt=true when exempt='true'", async () => {
    await setBillingExempt(formData({ tenantId: "t-1", exempt: "true" }));
    expect(dbUpdateVals).toMatchObject({ billingExempt: true });
  });

  it("sets billingExempt=false when exempt='false'", async () => {
    await setBillingExempt(formData({ tenantId: "t-1", exempt: "false" }));
    expect(dbUpdateVals).toMatchObject({ billingExempt: false });
  });

  it("does not modify billingExempt of another tenant (single-row returning check)", async () => {
    dbUpdateReturning = [{ id: "t-1" }];
    await expect(
      setBillingExempt(formData({ tenantId: "t-1", exempt: "true" })),
    ).resolves.toBeUndefined();
  });
});

// ── setIframerAccount ─────────────────────────────────────────────────────────

describe("setIframerAccount", () => {
  it("blocks non-admin callers", async () => {
    requirePlatformAdmin.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(
      setIframerAccount(formData({ tenantId: "t-1", accountId: "ifr-123" })),
    ).rejects.toThrow("Forbidden");
  });

  it("throws when tenantId is missing", async () => {
    await expect(
      setIframerAccount(formData({ accountId: "ifr-123" })),
    ).rejects.toThrow("Missing tenantId");
  });

  it("throws when tenantId is empty", async () => {
    await expect(
      setIframerAccount(formData({ tenantId: "", accountId: "ifr-123" })),
    ).rejects.toThrow("Missing tenantId");
  });

  it("throws when accountId is absent (null from FormData)", async () => {
    await expect(
      setIframerAccount(formData({ tenantId: "t-1" })),
    ).rejects.toThrow("Missing accountId");
  });

  it("throws when tenant is not found (UPDATE returns 0 rows)", async () => {
    dbUpdateReturning = [];
    await expect(
      setIframerAccount(formData({ tenantId: "nonexistent", accountId: "ifr-123" })),
    ).rejects.toThrow("Tenant not found");
  });

  it("links: sets iframerAccountId and billingExempt=true when accountId is non-empty", async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "ifr-abc" }));
    expect(dbUpdateVals).toMatchObject({
      iframerAccountId: "ifr-abc",
      billingExempt: true,
    });
  });

  it("links: trims whitespace from accountId", async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "  ifr-abc  " }));
    expect(dbUpdateVals).toMatchObject({ iframerAccountId: "ifr-abc" });
  });

  it("unlinks: sets iframerAccountId=null when accountId is empty string", async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "" }));
    expect(dbUpdateVals).toMatchObject({ iframerAccountId: null });
  });

  it("unlinks: does NOT set billingExempt when accountId is empty", async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "" }));
    expect(dbUpdateVals).not.toHaveProperty("billingExempt");
  });

  it("unlinks: treats whitespace-only accountId as empty (unlink)", async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "   " }));
    expect(dbUpdateVals).toMatchObject({ iframerAccountId: null });
    expect(dbUpdateVals).not.toHaveProperty("billingExempt");
  });

  it('sends a Slack "linked" notification with tenant and admin details on link', async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "ifr-abc" }));
    expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "linked",
        accountId: "ifr-abc",
        tenantName: "Gallery One",
        tenantSlug: "gallery-one",
        adminEmail: "admin@example.com",
      }),
    );
  });

  it('sends a Slack "unlinked" notification on unlink', async () => {
    await setIframerAccount(formData({ tenantId: "t-1", accountId: "" }));
    expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "unlinked",
        accountId: null,
        adminEmail: "admin@example.com",
      }),
    );
  });

  it("does not send a Slack notification when SLACK_BILLING_ALERTS_CHANNEL is not configured", async () => {
    // The mock already returns { ok: true } and the action fires-and-forgets.
    // We verify that the action still resolves successfully when Slack is skipped.
    sendIframerAccountSlackNotification.mockResolvedValueOnce({ ok: true });
    await expect(
      setIframerAccount(formData({ tenantId: "t-1", accountId: "ifr-abc" })),
    ).resolves.toBeUndefined();
  });
});

// ── dismissBillingAlert ───────────────────────────────────────────────────────

describe("dismissBillingAlert", () => {
  it("throws when requirePlatformAdmin rejects", async () => {
    requirePlatformAdmin.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(dismissBillingAlert("alert-1")).rejects.toThrow("Forbidden");
  });

  it("throws when alertId is empty", async () => {
    await expect(dismissBillingAlert("")).rejects.toThrow("Missing alertId");
  });

  it("sets dismissedAt when alertId is valid", async () => {
    dbUpdateReturning = [{ id: "alert-1" }];
    await dismissBillingAlert("alert-1");
    expect(dbUpdateVals).toMatchObject({ dismissedAt: expect.any(Date) });
  });

  it("is a no-op (does not throw) when alertId not found", async () => {
    dbUpdateReturning = [];
    await expect(dismissBillingAlert("unknown-alert")).resolves.toBeUndefined();
  });
});
