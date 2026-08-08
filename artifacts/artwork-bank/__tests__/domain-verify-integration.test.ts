/**
 * verifyCustomDomain — real-DB integration.
 *
 * DNS is mocked (no real network lookup); the DB writes are real:
 *
 *  1. CNAME matches → customDomainVerified=true; redirects ?domain_status=verified.
 *  2. CNAME resolves to wrong host → customDomainVerified=false; redirects ?domain_status=conflict.
 *  3. DNS throws (NXDOMAIN etc.) → customDomainVerified=false; redirects ?domain_status=unverified.
 *  4. No customDomain set → redirects /settings (no DB write).
 *  5. No CNAME target configured (env) → redirects ?domain_status=no_cname_target.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-domain-verify", tenantId: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// ── CNAME target — controlled per-test ───────────────────────────────────────
const mockGetCnameTarget = vi.hoisted(() => vi.fn(() => "proxy.example.com"));
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: mockGetCnameTarget,
  getTenantBySlug: vi.fn(),
}));

// ── Vercel provisioning — no-op ───────────────────────────────────────────────
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

// ── DNS — controlled per-test ─────────────────────────────────────────────────
const mockResolveCname = vi.hoisted(() => vi.fn(async (_domain: string): Promise<string[]> => []));
vi.mock("node:dns/promises", () => ({
  resolveCname: mockResolveCname,
}));

import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────
const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-dv-${RUN}-${++seq}`; }

async function createTenant(customDomain: string | null = "gallery.test") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Domain Verify Test Gallery",
    type: "ARTIST", billingExempt: true,
    ...(customDomain ? { customDomain } : {}),
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => { mockResolveCname.mockReset(); await cleanup(); });
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("verifyCustomDomain — real-DB integration", () => {
  it("CNAME matches → customDomainVerified=true; redirects ?domain_status=verified", async () => {
    const tenantId = await createTenant("gallery.test");
    mockResolveCname.mockResolvedValueOnce(["proxy.example.com"]);

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:/settings?domain_status=verified");

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.customDomainVerified).toBe(true);
  });

  it("CNAME with trailing dot matches too", async () => {
    const tenantId = await createTenant("gallery2.test");
    mockResolveCname.mockResolvedValueOnce(["proxy.example.com."]);

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:/settings?domain_status=verified");

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.customDomainVerified).toBe(true);
  });

  it("CNAME resolves to wrong host → customDomainVerified=false; redirects ?domain_status=conflict", async () => {
    const tenantId = await createTenant("conflict.test");
    mockResolveCname.mockResolvedValueOnce(["otherprovider.net"]);

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:/settings?domain_status=conflict");

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.customDomainVerified).toBe(false);
  });

  it("DNS throws (NXDOMAIN) → customDomainVerified=false; redirects ?domain_status=unverified", async () => {
    const tenantId = await createTenant("nxdomain.test");
    mockResolveCname.mockRejectedValueOnce(new Error("ENOTFOUND"));

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:/settings?domain_status=unverified");

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.customDomainVerified).toBe(false);
  });

  it("no customDomain set → redirects /settings (no DB write)", async () => {
    await createTenant(null);

    await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:/settings");

    // The test simply confirms redirect; no DB customDomainVerified field to assert on.
  });

  it("no CNAME target configured → redirects ?domain_status=no_cname_target", async () => {
    await createTenant("gallery3.test");
    mockGetCnameTarget.mockReturnValueOnce(null);

    await expect(verifyCustomDomain()).rejects.toThrow(
      "REDIRECT:/settings?domain_status=no_cname_target",
    );
    // DNS should not have been consulted.
    expect(mockResolveCname).not.toHaveBeenCalled();
  });
});
