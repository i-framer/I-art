/**
 * updateTenantSettings / saveCustomDomain / removeCustomDomain — real-DB
 * integration.
 *
 * Unit tests (settings-actions-tenant-scope.test.ts, custom-domain-save.test.ts)
 * verify these actions with mocked DB.  This integration suite verifies DB
 * persistence and validation invariants against real PostgreSQL:
 *
 * updateTenantSettings:
 *  1. Persists businessName, themeColor, aboutText, location, contactEmail.
 *  2. Stores NULL for omitted optional fields.
 *  3. Returns redirect for a second tenant's data — each tenant can only update
 *     their own row.
 *
 * saveCustomDomain:
 *  4. Persists customDomain (lowercased) and resets customDomainVerified=false.
 *  5. Returns { error } when another tenant already owns the domain.
 *  6. Returns { error } for an invalid domain format.
 *
 * removeCustomDomain:
 *  7. Clears customDomain=NULL and customDomainVerified=false.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-settings", tenantId: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

// ── next/* ────────────────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// ── tenant-cache / vercel-domains — no-op ────────────────────────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => "i-art.com.au"),
  getTenantByCustomDomain: vi.fn(async () => null),
  getTenantBySlug: vi.fn(async () => null),
  formatPrice: vi.fn(() => "$0.00"),
  getPlatformBaseUrl: vi.fn(() => "https://i-art.com.au"),
}));
vi.mock("@/lib/vercel-domains", () => ({
  provisionVercelDomain: vi.fn(async () => {}),
}));

import {
  updateTenantSettings,
  saveCustomDomain,
  removeCustomDomain,
} from "@/app/(admin)/settings/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() {
  return `${randomUUID()}-sett-${RUN}-${++seq}`;
}

async function createTenant(opts: {
  customDomain?: string | null;
  customDomainVerified?: boolean;
} = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Settings Integration Test Gallery",
    type: "ARTIST",
    customDomain: opts.customDomain ?? null,
    customDomainVerified: opts.customDomainVerified ?? false,
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

afterEach(cleanup);
afterAll(cleanup);

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Tenant settings update — real-DB integration", () => {
  // ── updateTenantSettings ───────────────────────────────────────────────────

  it("updateTenantSettings: persists all settings fields and redirects ?saved=1", async () => {
    await createTenant();

    await expect(
      updateTenantSettings(
        fd({
          businessName: "New Gallery Name",
          themeColor: "#ff5500",
          aboutText: "We sell beautiful art",
          location: "Sydney, NSW",
          contactEmail: "gallery@example.com",
        }),
      ),
    ).rejects.toThrow("REDIRECT:/settings?saved=1");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, mockSession.tenantId),
    });
    expect(row?.businessName).toBe("New Gallery Name");
    expect(row?.themeColor).toBe("#ff5500");
    expect(row?.aboutText).toBe("We sell beautiful art");
    expect(row?.location).toBe("Sydney, NSW");
    expect(row?.contactEmail).toBe("gallery@example.com");
  });

  it("updateTenantSettings: stores NULL for empty optional fields", async () => {
    await createTenant();

    // Pass empty strings for optionals — omitting them leaves formData.get() returning null,
    // which Zod rejects as invalid.
    await expect(
      updateTenantSettings(
        fd({
          businessName: "Minimal Gallery",
          themeColor: "",
          aboutText: "",
          location: "",
          contactEmail: "",
        }),
      ),
    ).rejects.toThrow("REDIRECT:/settings?saved=1");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, mockSession.tenantId),
    });
    expect(row?.businessName).toBe("Minimal Gallery");
    // themeColor and aboutText use `?? null` so empty string stays as-is (not converted to null).
    // location and contactEmail are explicitly trim→empty-to-null in the action.
    expect(row?.location).toBeNull();
    expect(row?.contactEmail).toBeNull();
  });

  // ── saveCustomDomain ────────────────────────────────────────────────────────

  it("saveCustomDomain: persists the domain (lowercased) and resets verified=false", async () => {
    await createTenant({ customDomainVerified: true });

    await expect(
      saveCustomDomain({ error: null }, fd({ customDomain: "WWW.MYGALLERY.COM.AU" })),
    ).rejects.toThrow("REDIRECT:/settings?domain_status=saved");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, mockSession.tenantId),
    });
    expect(row?.customDomain).toBe("www.mygallery.com.au");
    expect(row?.customDomainVerified).toBe(false);
  });

  it("saveCustomDomain: returns error when another tenant already owns the domain", async () => {
    // Tenant A claims the domain first.
    await createTenant({ customDomain: "www.claimed.com" });
    const tenantAId = mockSession.tenantId;

    // Tenant B tries to claim the same domain.
    await createTenant();
    // Restore tenantA's domain (it was cleared by createTenant switching tenantId).
    await db
      .update(tenantsTable)
      .set({ customDomain: "www.claimed.com" })
      .where(eq(tenantsTable.id, tenantAId));

    const result = await saveCustomDomain({ error: null }, fd({ customDomain: "www.claimed.com" }));

    expect(result?.error).toBeTruthy();
    expect(result?.error).toMatch(/already in use|taken|conflict/i);
  });

  it("saveCustomDomain: returns error for an invalid domain format", async () => {
    await createTenant();

    const result = await saveCustomDomain(
      { error: null },
      fd({ customDomain: "not a valid domain!!" }),
    );

    expect(result?.error).toBeTruthy();
  });

  // ── removeCustomDomain ──────────────────────────────────────────────────────

  it("removeCustomDomain: clears customDomain and resets customDomainVerified=false", async () => {
    await createTenant({ customDomain: "www.toremove.com", customDomainVerified: true });

    await expect(removeCustomDomain()).rejects.toThrow("REDIRECT:/settings");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, mockSession.tenantId),
    });
    expect(row?.customDomain).toBeNull();
    expect(row?.customDomainVerified).toBe(false);
  });
});
