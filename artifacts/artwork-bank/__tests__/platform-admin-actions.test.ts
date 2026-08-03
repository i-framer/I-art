/**
 * Platform admin actions — setBillingExempt and dismissBillingAlert.
 *
 * Covers:
 *  - Non-platform-admin callers are blocked by requirePlatformAdmin
 *  - setBillingExempt flips billingExempt on the correct tenant
 *  - setBillingExempt throws when tenantId is missing or empty
 *  - setBillingExempt throws when exempt param is invalid
 *  - setBillingExempt throws when tenant is not found (UPDATE returns 0 rows)
 *  - dismissBillingAlert marks alertId as dismissed
 *  - dismissBillingAlert is a no-op (not an error) for an unknown alertId
 *  - dismissBillingAlert throws when alertId is empty
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  tenantsTable: { id: "tenants.id", billingExempt: "tenants.billingExempt" },
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
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn().mockReturnValue(null),
  sendBillingAlertSlackNotification: vi.fn(),
}));

import { setBillingExempt, dismissBillingAlert } from "@/app/platform/actions";

function formData(fields: Record<string, string>): FormData {
  return {
    get: (k: string) => fields[k] ?? null,
  } as unknown as FormData;
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePlatformAdmin.mockResolvedValue(undefined);
  dbUpdateReturning = [{ id: "tenant-1" }];
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
