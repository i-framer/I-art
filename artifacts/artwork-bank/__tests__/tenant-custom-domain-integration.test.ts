/**
 * saveCustomDomain / removeCustomDomain actions — real-DB integration.
 *
 * app/(admin)/settings/actions.ts:121-220:
 *   saveCustomDomain: validates format, rejects duplicate, sets customDomain +
 *     customDomainVerified=false, then redirects.
 *   removeCustomDomain: clears both fields, then redirects.
 *
 *  1. saveCustomDomain persists domain and sets customDomainVerified=false.
 *  2. Duplicate domain used by another tenant is rejected with error.
 *  3. Same tenant saving its own domain again (re-save) is allowed.
 *  4. removeCustomDomain clears customDomain to null.
 *  5. removeCustomDomain sets customDomainVerified to false.
 *  6. Foreign tenant cannot overwrite another tenant's domain.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-tcdi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-domain", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("@/lib/vercel", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
  removeVercelDomain: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { saveCustomDomain, removeCustomDomain } from "@/app/(admin)/settings/actions";

async function createTenant(opts: { customDomain?: string; customDomainVerified?: boolean } = {}) {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Domain Test Gallery", type: "ARTIST",
    customDomain: opts.customDomain ?? null,
    customDomainVerified: opts.customDomainVerified ?? false,
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function tenantDomainFields(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return { customDomain: row?.customDomain ?? null, customDomainVerified: row?.customDomainVerified ?? null };
}

function saveFd(domain: string) {
  const f = new FormData();
  f.set("customDomain", domain);
  return f;
}

async function callSave(domain: string): Promise<{ error: string | null }> {
  const result = await saveCustomDomain({ error: null }, saveFd(domain)).catch((err: Error) => {
    if (err.message.startsWith("REDIRECT:")) return null;
    throw err;
  });
  return result ?? { error: null };
}

async function callRemove(): Promise<void> {
  await removeCustomDomain().catch((err: Error) => {
    if (!err.message.startsWith("REDIRECT:")) throw err;
  });
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("saveCustomDomain / removeCustomDomain — real-DB integration", () => {
  it("saveCustomDomain persists domain and sets customDomainVerified=false", async () => {
    const { tenantId } = await createTenant();

    await callSave("www.domain-test-gallery.com");

    const { customDomain, customDomainVerified } = await tenantDomainFields(tenantId);
    expect(customDomain).toBe("www.domain-test-gallery.com");
    expect(customDomainVerified).toBe(false);
  });

  it("duplicate domain used by another tenant is rejected with error", async () => {
    const { tenantId: _tenantA } = await createTenant({ customDomain: "www.taken-domain.com" });
    const { tenantId: tenantB } = await createTenant();

    mockSession.value = { ...mockSession.value, tenantId: tenantB };
    const result = await callSave("www.taken-domain.com");

    expect(result?.error).toMatch(/already in use/i);

    // Tenant B domain must be unchanged.
    const { customDomain } = await tenantDomainFields(tenantB);
    expect(customDomain).toBeNull();
  });

  it("same tenant re-saving its own domain is allowed (no duplicate error)", async () => {
    const domain = "www.my-own-domain.com";
    const { tenantId } = await createTenant({ customDomain: domain });

    const result = await callSave(domain);

    expect(result?.error).toBeNull();
    const { customDomain } = await tenantDomainFields(tenantId);
    expect(customDomain).toBe(domain);
  });

  it("removeCustomDomain clears customDomain to null", async () => {
    const { tenantId } = await createTenant({ customDomain: "www.to-remove.com" });

    await callRemove();

    const { customDomain } = await tenantDomainFields(tenantId);
    expect(customDomain).toBeNull();
  });

  it("removeCustomDomain sets customDomainVerified to false", async () => {
    const { tenantId } = await createTenant({
      customDomain: "www.verified.com",
      customDomainVerified: true,
    });

    await callRemove();

    const { customDomainVerified } = await tenantDomainFields(tenantId);
    expect(customDomainVerified).toBe(false);
  });

  it("duplicate rejection is tenant-isolated (own domain update proceeds)", async () => {
    // Create two tenants with different domains.
    const domainA = "www.unique-a.com";
    const domainB = "www.unique-b.com";
    const { tenantId: tenantA } = await createTenant({ customDomain: domainA });
    const { tenantId: _tenantB } = await createTenant({ customDomain: domainB });

    // Tenant A saves its own domain — must succeed.
    mockSession.value = { ...mockSession.value, tenantId: tenantA };
    const result = await callSave(domainA);

    expect(result?.error).toBeNull();
    const { customDomain } = await tenantDomainFields(tenantA);
    expect(customDomain).toBe(domainA);
  });
});
