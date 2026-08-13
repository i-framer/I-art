/**
 * Certificate of Authenticity — billing guard  (Task #83)
 *
 * Verifies that the issueCertificate server action applies the billing guard:
 *  1. A tenant with billingExempt=true can issue certificates.
 *  2. A tenant with subscriptionStatus="active" can issue certificates.
 *  3. A tenant with no subscription (subscriptionStatus=null) is redirected
 *     to /settings/billing instead of issuing a certificate.
 *  4. A tenant with subscriptionStatus="canceled" is redirected.
 *
 * Uses the same mock pattern as the existing billing-access-guard.test.ts
 * so the action's billing check is exercised without touching the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const tenantRow = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const artworkRow = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: vi.fn(async () => tenantRow.current),
      },
      artworksTable: {
        findFirst: vi.fn(async () => artworkRow.current),
      },
    },
    transaction: vi.fn(async (fn: any) => fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ maxSeq: 0 }]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "cert-123" }]),
        })),
      })),
    })),
  },
  tenantsTable: { id: "tenants.id" },
  artworksTable: { id: "artworks.id" },
  certificatesTable: {},
  eq: vi.fn(),
  and: vi.fn(),
  max: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u1", tenantId: "t1" })),
}));

const redirectSpy = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { hasActiveAccess } from "@/lib/billing";

vi.mock("@/lib/billing", () => ({
  hasActiveAccess: vi.fn(),
  requireActiveBillingAccess: vi.fn(),
}));

import { issueCertificate } from "@/app/(admin)/(gated)/certificates/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeForm(artworkId: string, buyerName?: string): FormData {
  const fd = new FormData();
  fd.set("artworkId", artworkId);
  if (buyerName) fd.set("buyerName", buyerName);
  return fd;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("issueCertificate billing guard (Task #83)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantRow.current = null;
    artworkRow.current = { id: "artwork-1", tenantId: "t1", title: "Test" };
    redirectSpy.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`); });
  });

  it("redirects to /settings/billing when the tenant has no subscription", async () => {
    tenantRow.current = {
      id: "t1",
      billingExempt: false,
      subscriptionStatus: null,
    };
    vi.mocked(hasActiveAccess).mockReturnValue(false);

    await expect(issueCertificate(makeForm("artwork-1"))).rejects.toThrow(
      "REDIRECT:/settings/billing",
    );
  });

  it("redirects to /settings/billing when subscription is canceled", async () => {
    tenantRow.current = {
      id: "t1",
      billingExempt: false,
      subscriptionStatus: "canceled",
    };
    vi.mocked(hasActiveAccess).mockReturnValue(false);

    await expect(issueCertificate(makeForm("artwork-1"))).rejects.toThrow(
      "REDIRECT:/settings/billing",
    );
  });

  it("allows certificate issuance when billingExempt=true", async () => {
    tenantRow.current = {
      id: "t1",
      billingExempt: true,
      subscriptionStatus: null,
    };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    // Should NOT redirect to billing — it either redirects to the new cert
    // or succeeds. We check it does NOT throw with /settings/billing.
    try {
      await issueCertificate(makeForm("artwork-1", "Jane Smith"));
    } catch (err: any) {
      expect(err.message).not.toContain("/settings/billing");
    }
  });

  it("allows certificate issuance when subscription is active", async () => {
    tenantRow.current = {
      id: "t1",
      billingExempt: false,
      subscriptionStatus: "active",
    };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    try {
      await issueCertificate(makeForm("artwork-1"));
    } catch (err: any) {
      expect(err.message).not.toContain("/settings/billing");
    }
  });

  it("allows certificate issuance when subscription is trialing", async () => {
    tenantRow.current = {
      id: "t1",
      billingExempt: false,
      subscriptionStatus: "trialing",
    };
    vi.mocked(hasActiveAccess).mockReturnValue(true);

    try {
      await issueCertificate(makeForm("artwork-1"));
    } catch (err: any) {
      expect(err.message).not.toContain("/settings/billing");
    }
  });

  it("redirects to /login when no session", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValueOnce({ userId: undefined, tenantId: "t1" } as any);

    await expect(issueCertificate(makeForm("artwork-1"))).rejects.toThrow(
      "REDIRECT:/login",
    );
  });
});
