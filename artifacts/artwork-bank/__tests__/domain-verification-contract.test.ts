/**
 * Task #67 — Confirm domain verification matches the DNS instructions shown
 * to tenants.
 *
 * The domain settings page shows tenants "Point your CNAME to <target>" where
 * <target> comes from getCnameTarget(). The verifyCustomDomain action must
 * accept exactly that same value as a passing CNAME record (case-insensitive,
 * trailing-dot normalized).
 *
 * Covers:
 *  - Exact match → verified
 *  - Case-insensitive match → verified
 *  - Trailing dot in DNS response → verified (DNS resolvers often append one)
 *  - CNAME points to a different host → conflict
 *  - No CNAME record (NXDOMAIN/ENODATA) → unverified
 *  - Verified: customDomainVerified flipped to true
 *  - Conflict/unverified: customDomainVerified stays false
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ── DNS mock ──────────────────────────────────────────────────────────────────
const resolveCname = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock("node:dns/promises", () => ({ resolveCname }));

// ── CNAME-target mock (controls what instructions say) ────────────────────────
const getCnameTarget = vi.hoisted(() => vi.fn<() => string | null>());
vi.mock("@/lib/tenant-cache", () => ({ getCnameTarget }));

// ── DB state recorder ─────────────────────────────────────────────────────────
const savedVals: Array<Record<string, unknown>> = [];
const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: { tenantsTable: { findFirst: tenantFindFirst } },
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          savedVals.push(vals);
        },
      }),
    }),
  },
  tenantsTable: { id: "tenants.id" },
  eq: vi.fn(),
}));

// ── Auth + Vercel mocks ───────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-1",
    role: "owner",
  })),
}));

vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

// ── Redirect capture ──────────────────────────────────────────────────────────
const REDIRECTS: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    REDIRECTS.push(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

function CNAME_TARGET() { return "cname.i-art.com.au"; }

async function runVerify() {
  try {
    await verifyCustomDomain();
  } catch (e: any) {
    if (!e?.message?.startsWith("REDIRECT:")) throw e;
  }
}

beforeEach(() => {
  savedVals.length = 0;
  REDIRECTS.length = 0;
  vi.clearAllMocks();
  getCnameTarget.mockReturnValue(CNAME_TARGET());
  tenantFindFirst.mockResolvedValue({
    id: "tenant-1",
    customDomain: "gallery.example.com",
    customDomainVerified: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("domain verification — instruction contract (Task #67)", () => {
  it("verifies when DNS CNAME exactly matches the instruction target", async () => {
    resolveCname.mockResolvedValueOnce(["cname.i-art.com.au"]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(true);
    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=verified");
  });

  it("verifies when DNS CNAME matches case-insensitively", async () => {
    resolveCname.mockResolvedValueOnce(["CNAME.I-ART.COM.AU"]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(true);
  });

  it("verifies when DNS CNAME has a trailing dot (common resolver behavior)", async () => {
    resolveCname.mockResolvedValueOnce(["cname.i-art.com.au."]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(true);
    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=verified");
  });

  it("treats trailing dot with different case as a match", async () => {
    resolveCname.mockResolvedValueOnce(["CNAME.I-ART.COM.AU."]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(true);
  });

  it("reports conflict when CNAME points to a different host", async () => {
    resolveCname.mockResolvedValueOnce(["otherhost.somecdn.net"]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(false);
    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=conflict");
  });

  it("reports unverified when DNS lookup throws (NXDOMAIN/timeout)", async () => {
    resolveCname.mockRejectedValueOnce(
      Object.assign(new Error("ENOTFOUND gallery.example.com"), { code: "ENOTFOUND" }),
    );

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(false);
    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=unverified");
  });

  it("reports unverified when DNS returns an empty array", async () => {
    resolveCname.mockResolvedValueOnce([]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(false);
    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=unverified");
  });

  it("the instruction CNAME target is exactly what DNS comparison uses", async () => {
    // Set the target to a custom value simulating CNAME_TARGET env var
    const customTarget = "custom-cname.acme.com";
    getCnameTarget.mockReturnValue(customTarget);

    resolveCname.mockResolvedValueOnce([customTarget]);

    await runVerify();

    // Verifies → the DNS record matches the exact value tenants are instructed to use
    expect(savedVals.at(-1)?.customDomainVerified).toBe(true);
  });

  it("does NOT verify if CNAME points to old/wrong target", async () => {
    // Instruction says point to "cname.i-art.com.au" but tenant pointed to old value
    resolveCname.mockResolvedValueOnce(["old-target.vercel.com"]);

    await runVerify();

    expect(savedVals.at(-1)?.customDomainVerified).toBe(false);
  });

  it("redirects to no_cname_target when getCnameTarget() returns null", async () => {
    getCnameTarget.mockReturnValue(null);

    await runVerify();

    expect(REDIRECTS.at(-1)).toBe("/settings?domain_status=no_cname_target");
    // No DB update should happen
    expect(savedVals.length).toBe(0);
  });
});
