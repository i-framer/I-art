/**
 * Custom domain verification — real-DB happy-path and conflict-path (Task #67).
 *
 * The unit tests (domain-verification-contract.test.ts) cover all logic
 * branches with mocked DB.  This integration suite verifies the same paths
 * against PostgreSQL:
 *
 *  1. DNS matches the configured target → customDomainVerified=true in DB,
 *     redirect to ?domain_status=verified.
 *  2. DNS returns a different host → customDomainVerified=false in DB,
 *     redirect to ?domain_status=conflict.
 *  3. DNS throws (NXDOMAIN) → customDomainVerified=false in DB,
 *     redirect to ?domain_status=unverified.
 *  4. A previously-verified domain that now resolves to a different host is
 *     set to false (conflict) — no stale true remains.
 *
 * DNS is mocked throughout (we don't own the test domain).
 * getCnameTarget, provisionVercelDomain, and next/* are also mocked.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Auth — return a synthetic session pointing at the test tenant ─────────────
const mockSession = vi.hoisted(() => ({
  userId: "test-user-domain-happy",
  tenantId: "PLACEHOLDER",
  role: "owner" as const,
  email: "domain-test@example.com",
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

// ── CNAME target ──────────────────────────────────────────────────────────────
const mockCnameTarget = vi.hoisted(() => ({ value: "i-art.com.au" }));
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => mockCnameTarget.value),
  getTenantByCustomDomain: vi.fn(async () => null),
  getTenantBySlug: vi.fn(async () => null),
  formatPrice: vi.fn(() => "$0.00"),
  getPlatformBaseUrl: vi.fn(() => "https://i-art.com.au"),
}));

// ── DNS resolution — controlled per test ─────────────────────────────────────
const resolveCname = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock("node:dns/promises", () => ({ resolveCname }));

// ── Vercel provisioning — no-op (avoids real API call) ───────────────────────
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

// ── next/* ────────────────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ── Slack — no-op ────────────────────────────────────────────────────────────
vi.mock("@/lib/slack", () => ({
  sendIframerAccountSlackNotification: vi.fn(async () => ({})),
  sendBillingAlertSlackNotification: vi.fn(async () => ({})),
  resolveSlackChannel: vi.fn(() => null),
}));

import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const CREATED_IDS: string[] = [];

function uid() {
  return `test-domain-happy-${RUN}-${++seq}`;
}

async function createTenant(opts: {
  customDomain?: string;
  customDomainVerified?: boolean;
} = {}) {
  const id = uid();
  CREATED_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Domain Verify Happy Path Test",
    type: "ARTIST",
    customDomain: opts.customDomain ?? `www.${id}.test`,
    customDomainVerified: opts.customDomainVerified ?? false,
  } as any);
  return id;
}

afterEach(async () => {
  for (const id of CREATED_IDS.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

afterAll(async () => {
  for (const id of CREATED_IDS.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "verifyCustomDomain — real-DB happy path and status transitions (Task #67)",
  () => {
    it("sets customDomainVerified=true in DB and redirects verified when DNS matches", async () => {
      const tenantId = await createTenant({ customDomainVerified: false });
      mockSession.tenantId = tenantId;

      // DNS returns our target (with trailing dot — real DNS behaviour).
      resolveCname.mockResolvedValueOnce(["i-art.com.au."]);

      await expect(verifyCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?domain_status=verified",
      );

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      expect(row?.customDomainVerified).toBe(true);
    });

    it("sets customDomainVerified=false in DB and redirects conflict when DNS points elsewhere", async () => {
      const tenantId = await createTenant({ customDomainVerified: false });
      mockSession.tenantId = tenantId;

      resolveCname.mockResolvedValueOnce(["some-other-host.com."]);

      await expect(verifyCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?domain_status=conflict",
      );

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      expect(row?.customDomainVerified).toBe(false);
    });

    it("sets customDomainVerified=false and redirects unverified when DNS throws (NXDOMAIN)", async () => {
      const tenantId = await createTenant({ customDomainVerified: false });
      mockSession.tenantId = tenantId;

      resolveCname.mockRejectedValueOnce(
        Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
      );

      await expect(verifyCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?domain_status=unverified",
      );

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      expect(row?.customDomainVerified).toBe(false);
    });

    it("reverts a stale true to false when DNS now returns a conflicting host", async () => {
      // Ensure a previously-verified domain that changed its DNS is corrected.
      const tenantId = await createTenant({ customDomainVerified: true });
      mockSession.tenantId = tenantId;

      resolveCname.mockResolvedValueOnce(["attacker.example.com."]);

      await expect(verifyCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?domain_status=conflict",
      );

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      // Must be false — cannot keep a stale verified flag.
      expect(row?.customDomainVerified).toBe(false);
    });
  },
);
