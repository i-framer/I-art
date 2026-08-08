/**
 * Gallery storefront — missing / disabled tenant gate — real-DB integration.
 *
 * app/t/[slug]/layout.tsx calls getTenantBySlug(slug) and notFound() when:
 *   - No tenant matches the slug.
 *   - Tenant exists but storefrontEnabled=false.
 *
 * This suite exercises the tenant-resolution layer directly (DB query)
 * and the storefront API/page guard, documenting the real DB contract.
 *
 *  1. Non-existent slug → getTenantBySlug returns undefined.
 *  2. storefrontEnabled=false tenant → getTenantBySlug returns the row
 *     (layout must check storefrontEnabled separately).
 *  3. storefrontEnabled=true tenant → row returned with correct slug.
 *  4. Disabling storefrontEnabled → next lookup returns the row still
 *     (but layout would then call notFound).
 *  5. Re-enabling storefrontEnabled → row returned with storefrontEnabled=true.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getTenantBySlug } from "@/lib/tenant-cache";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-slmt-${RUN}-${++seq}`; }

async function createTenant(storefrontEnabled: boolean) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Layout Gate Test", type: "ARTIST",
    storefrontEnabled,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Storefront layout tenant gate — real-DB integration", () => {
  it("non-existent slug → getTenantBySlug returns undefined/null", async () => {
    const result = await getTenantBySlug(`slug-nonexistent-${uid()}`);
    expect(result).toBeFalsy();
  });

  it("storefrontEnabled=false → getTenantBySlug still returns the row", async () => {
    const { slug } = await createTenant(false);

    const result = await getTenantBySlug(slug);

    // Row is returned (tenant exists); layout guards against storefrontEnabled=false
    expect(result).not.toBeFalsy();
    expect(result?.storefrontEnabled).toBe(false);
  });

  it("storefrontEnabled=true → getTenantBySlug returns row with correct slug", async () => {
    const { slug } = await createTenant(true);

    const result = await getTenantBySlug(slug);

    expect(result).not.toBeFalsy();
    expect(result?.slug).toBe(slug);
    expect(result?.storefrontEnabled).toBe(true);
  });

  it("disabling storefrontEnabled → next lookup returns storefrontEnabled=false", async () => {
    const { slug, tenantId } = await createTenant(true);

    await db.update(tenantsTable).set({ storefrontEnabled: false } as any).where(eq(tenantsTable.id, tenantId));

    const result = await getTenantBySlug(slug);

    // The layout would call notFound() when storefrontEnabled=false.
    expect(result?.storefrontEnabled).toBe(false);
  });

  it("re-enabling storefrontEnabled → lookup returns storefrontEnabled=true", async () => {
    const { slug, tenantId } = await createTenant(false);

    await db.update(tenantsTable).set({ storefrontEnabled: true } as any).where(eq(tenantsTable.id, tenantId));

    const result = await getTenantBySlug(slug);

    expect(result?.storefrontEnabled).toBe(true);
  });
});
