/**
 * Domain verification: conflict detection
 *
 * When verifyCustomDomain runs DNS resolution and the CNAME record exists but
 * points to a different host (not the platform's CNAME target), the action
 * should redirect with domain_status=conflict and leave customDomainVerified
 * as false.
 *
 * This is distinct from "unverified" (no DNS record found at all) and from
 * "verified" (CNAME correctly points to our target).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── state recorder ────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  updates: [] as { table: any; vals: any; where: any }[],
}));

// ── dns mock — resolved by each test ─────────────────────────────────────────
const resolveCname = vi.hoisted(() => vi.fn<() => Promise<string[]>>());

vi.mock("node:dns/promises", () => ({ resolveCname }));

// ── db mock ───────────────────────────────────────────────────────────────────
const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: { findFirst: tenantFindFirst },
    },
    update: vi.fn(() => ({
      set: (vals: any) => ({
        where: (where: any) => {
          state.updates.push({ table: "tenants", vals, where });
          return Promise.resolve();
        },
      }),
    })),
  },
  tenantsTable: { id: "tenants.id" },
}));

// ── auth / tenant-cache / vercel mocks ───────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  })),
}));

vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => "cname.i-art.com.au"),
}));

vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ── subject ───────────────────────────────────────────────────────────────────
import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  tenantFindFirst.mockResolvedValue({
    id: "tenant-A",
    customDomain: "www.janeart.com",
  });
});

describe("verifyCustomDomain — conflict detection", () => {
  it("redirects with domain_status=conflict when CNAME exists but points to a different host", async () => {
    // DNS resolves, but to someone else's host — not our CNAME target
    resolveCname.mockResolvedValue(["cname.someother-platform.io"]);

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=conflict",
    );
  });

  it("leaves customDomainVerified=false on a conflict", async () => {
    resolveCname.mockResolvedValue(["cname.someother-platform.io"]);

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].vals).toMatchObject({ customDomainVerified: false });
  });

  it("redirects with domain_status=verified when CNAME matches the target exactly", async () => {
    resolveCname.mockResolvedValue(["cname.i-art.com.au"]);

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=verified",
    );
    expect(state.updates[0].vals).toMatchObject({ customDomainVerified: true });
  });

  it("redirects with domain_status=verified when CNAME matches with a trailing dot", async () => {
    resolveCname.mockResolvedValue(["cname.i-art.com.au."]);

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=verified",
    );
    expect(state.updates[0].vals).toMatchObject({ customDomainVerified: true });
  });

  it("redirects with domain_status=unverified when CNAME lookup fails (no record)", async () => {
    resolveCname.mockRejectedValue(
      Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" }),
    );

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=unverified",
    );
    expect(state.updates[0].vals).toMatchObject({ customDomainVerified: false });
  });

  it("redirects with domain_status=unverified when lookup returns an empty record list", async () => {
    resolveCname.mockResolvedValue([]);

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=unverified",
    );
    expect(state.updates[0].vals).toMatchObject({ customDomainVerified: false });
  });
});
