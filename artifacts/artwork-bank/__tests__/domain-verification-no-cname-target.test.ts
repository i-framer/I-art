/**
 * Task #234 — Prevent a domain conflict from silently going unnoticed if the
 * operator has not set a CNAME target.
 *
 * When getCnameTarget() returns null (neither CNAME_TARGET env var nor a valid
 * NEXT_PUBLIC_SITE_URL is set), verifyCustomDomain must redirect to
 * ?domain_status=no_cname_target instead of proceeding with DNS resolution.
 * This ensures the operator sees a clear configuration error rather than a
 * misleading "conflict" or silent failure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────
const tenantFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: { tenantsTable: { findFirst: tenantFindFirst } },
    update: vi.fn(() => ({
      set: (_v: any) => ({ where: () => Promise.resolve() }),
    })),
  },
  tenantsTable: { id: "tenants.id" },
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    tenantId: "tenant-A",
    role: "owner",
  })),
}));

// ── DNS mock — should NOT be called when no CNAME target is set ───────────────
const resolveCname = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock("node:dns/promises", () => ({ resolveCname }));

// ── CNAME target: null (misconfigured) ────────────────────────────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => null),
}));

// ── Vercel / next/navigation mocks ────────────────────────────────────────────
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── subject ───────────────────────────────────────────────────────────────────
import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  tenantFindFirst.mockResolvedValue({
    id: "tenant-A",
    customDomain: "www.janeart.com",
  });
});

describe("verifyCustomDomain — missing CNAME target (Task #234)", () => {
  it("redirects to ?domain_status=no_cname_target when getCnameTarget() is null", async () => {
    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=no_cname_target",
    );
  });

  it("does NOT attempt DNS resolution when the CNAME target is unconfigured", async () => {
    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");
    expect(resolveCname).not.toHaveBeenCalled();
  });

  it("does NOT update customDomainVerified when the CNAME target is unconfigured", async () => {
    const { db } = await import("@workspace/db");
    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns no_cname_target even when the tenant has a custom domain set", async () => {
    // Ensures the guard fires before domain logic, not after
    tenantFindFirst.mockResolvedValue({
      id: "tenant-A",
      customDomain: "gallery.example.com",
    });
    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=no_cname_target",
    );
  });
});
