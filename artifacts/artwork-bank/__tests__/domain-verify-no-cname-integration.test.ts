/**
 * Task #234 — Prevent a domain conflict from silently going unnoticed if the
 * operator has not set a CNAME target — real DB round-trip.
 *
 * The unit test (domain-verification-no-cname-target.test.ts) verifies the
 * redirect is emitted.  This integration test verifies the DB contract: when
 * verifyCustomDomain() encounters a null CNAME target, it:
 *   1. Redirects to /settings?domain_status=no_cname_target.
 *   2. Does NOT update customDomainVerified in the database.
 *   3. Leaves customDomain intact.
 *
 * DNS resolution is mocked (we don't control DNS here); auth, tenant-cache,
 * and next/cache are mocked; only the Drizzle layer hits the real database.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Auth mock — return the test tenant ────────────────────────────────────────
const mockSession = vi.hoisted(() => ({
  userId: "test-user-domain-cname",
  tenantId: "PLACEHOLDER",
  role: "owner" as const,
  email: "test@example.com",
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

// ── CNAME target: null (operator has not set CNAME_TARGET) ───────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => null),
  getTenantByCustomDomain: vi.fn(async () => null),
  getTenantBySlug: vi.fn(async () => null),
  formatPrice: vi.fn(() => "$0.00"),
  getPlatformBaseUrl: vi.fn(() => null),
}));

// ── DNS — must not be called ──────────────────────────────────────────────────
vi.mock("node:dns/promises", () => ({
  resolveCname: vi.fn(async () => { throw new Error("DNS must not be called"); }),
}));

// ── Vercel domain provisioning — no-op ───────────────────────────────────────
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

// ── next/cache / next/navigation mocks ───────────────────────────────────────
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
  sendOrphanSweepSlackNotification: vi.fn(async () => ({})),
  resolveSlackChannel: vi.fn(() => null),
}));

// Import the action AFTER mocks.
import { verifyCustomDomain } from "@/app/(admin)/settings/actions";

// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const CREATED_IDS: string[] = [];

function uid() {
  return `test-cname-integ-${RUN}-${++seq}`;
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
    businessName: "CNAME Integration Test Gallery",
    type: "ARTIST",
    customDomain: opts.customDomain ?? `www.${id}.test`,
    customDomainVerified: opts.customDomainVerified ?? false,
  } as any);
  return id;
}

afterEach(async () => {
  for (const id of CREATED_IDS.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

afterAll(async () => {
  for (const id of CREATED_IDS.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "verifyCustomDomain — no CNAME target — real DB round-trip (Task #234)",
  () => {
    it("redirects to no_cname_target when getCnameTarget() returns null", async () => {
      const tenantId = await createTenant();
      mockSession.tenantId = tenantId;

      await expect(verifyCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?domain_status=no_cname_target",
      );
    });

    it("does NOT modify customDomainVerified in the DB when CNAME target is absent", async () => {
      const tenantId = await createTenant({ customDomainVerified: false });
      mockSession.tenantId = tenantId;

      await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      expect(row?.customDomainVerified).toBe(false);
    });

    it("does NOT flip a previously-verified domain to unverified when CNAME target is absent", async () => {
      // Edge case: a verified domain should stay verified — the guard must fire
      // before any DB update so it cannot accidentally wipe a good verification.
      const tenantId = await createTenant({ customDomainVerified: true });
      mockSession.tenantId = tenantId;

      await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      // Verification state must be unchanged (still true).
      expect(row?.customDomainVerified).toBe(true);
    });

    it("leaves customDomain unchanged in the DB when CNAME target is absent", async () => {
      const domain = `www.${uid()}.test`;
      const tenantId = await createTenant({ customDomain: domain });
      mockSession.tenantId = tenantId;

      await expect(verifyCustomDomain()).rejects.toThrow("REDIRECT:");

      const row = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantId),
      });
      expect(row?.customDomain).toBe(domain);
    });
  },
);
