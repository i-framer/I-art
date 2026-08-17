/**
 * Task #930 — Confirm a staff member can't save or remove a custom domain
 * even with a direct form POST — real-DB integration.
 *
 * The owner-only guards on saveCustomDomain and removeCustomDomain are unit-
 * tested with a mocked DB in settings-actions-tenant-scope.test.ts.  This
 * suite hits a live PostgreSQL database to confirm the guard fires before any
 * DB write reaches production, covering the full server-action path including
 * session deserialization.
 *
 *  1. saveCustomDomain called as staff → { error: "Only owners can manage
 *     custom domains." }, customDomain column unchanged.
 *  2. removeCustomDomain called as staff → throws REDIRECT:/settings?error=
 *     unauthorized, customDomain column unchanged.
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock ─────────────────────────────────────────────────────────────────
// We control the session via mockSession so tests can switch role at will.
const mockSession = {
  userId: "u-930",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test",
}));

// redirect() throws a recognisable error so we can assert on the URL without
// needing the full Next.js runtime.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// saveCustomDomain/removeCustomDomain do not touch Stripe or email-sweep, but
// the module-level import of the actions file pulls in email-sweep transitively;
// stub it to avoid connection errors in environments without those services.
vi.mock("@/lib/email-sweep", () => ({
  requeueNoContactEmailInquiries: vi.fn(async () => 0),
  requeueAllFailedInquiries: vi.fn(async () => 0),
}));

import { saveCustomDomain, removeCustomDomain } from "@/app/(admin)/settings/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];

function tenantId(label: string) {
  return `test-930-${RUN}-${label}`;
}

async function insertTenant(id: string, customDomain: string | null) {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Domain Guard Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    customDomain,
  } as any);
}

async function readDomain(id: string): Promise<string | null | undefined> {
  const row = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, id),
    columns: { customDomain: true },
  });
  return row?.customDomain;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const id of CREATED_TENANT_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "saveCustomDomain / removeCustomDomain — staff guard — real DB (Task #930)",
  () => {
    it("saveCustomDomain returns an error for a staff session and leaves the DB row unchanged", async () => {
      const id = tenantId("save");
      const originalDomain = `www.original-930-${RUN}.com`;
      await insertTenant(id, originalDomain);

      // Act as staff
      mockSession.tenantId = id;
      mockSession.role = "staff";

      const fd = new FormData();
      fd.set("customDomain", `www.new-domain-930-${RUN}.com`);
      const result = await saveCustomDomain({ error: null }, fd);

      expect(result).toEqual({ error: "Only owners can manage custom domains." });

      // DB must be untouched
      const domainAfter = await readDomain(id);
      expect(domainAfter).toBe(originalDomain);
    });

    it("removeCustomDomain redirects to /settings?error=unauthorized for a staff session and leaves the domain intact", async () => {
      const id = tenantId("remove");
      const originalDomain = `www.keep-me-930-${RUN}.com`;
      await insertTenant(id, originalDomain);

      // Act as staff
      mockSession.tenantId = id;
      mockSession.role = "staff";

      await expect(removeCustomDomain()).rejects.toThrow(
        "REDIRECT:/settings?error=unauthorized",
      );

      // Domain column must be unchanged
      const domainAfter = await readDomain(id);
      expect(domainAfter).toBe(originalDomain);
    });
  },
);
