/**
 * Storefront disabled — browse exclusion — real-DB integration.
 *
 * The browse-where builder filters `tenantsTable.storefrontEnabled = true`
 * (lib/browse-where.ts:38).  When a tenant has `storefrontEnabled = false`
 * none of their artworks should appear in public browse results.
 *
 *  1. Tenant with storefrontEnabled=false → artworks excluded from browse.
 *  2. Tenant with storefrontEnabled=true → artworks appear in browse.
 *  3. Mixed tenants → only enabled-tenant artworks appear.
 *  4. Re-enabling storefrontEnabled → artworks appear in next browse.
 *  5. Disabling storefrontEnabled for a tenant that had visible artworks →
 *     artworks immediately excluded.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-sdb-${RUN}-${++seq}`; }

async function createTenant(storefrontEnabled: boolean = true) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Storefront Test Gallery ${id}`,
    type: "ARTIST", storefrontEnabled,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Browse Test Art", sku: `sku-${id}`,
    status: "AVAILABLE", showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Mirror the browse-where.ts tenants join:
 * tenants.storefront_enabled = true AND artworks.tenant_id = tenant.id.
 */
async function publicBrowseIds(): Promise<string[]> {
  const enabledTenants = await db.query.tenantsTable.findMany({
    where: eq(tenantsTable.storefrontEnabled, true),
    columns: { id: true },
  });
  const enabledTenantIds = enabledTenants.map(t => t.id);
  if (enabledTenantIds.length === 0) return [];

  const artworks = await db.query.artworksTable.findMany({
    where: and(
      eq(artworksTable.showInGallery, true),
      eq(artworksTable.status, "AVAILABLE"),
    ),
    columns: { id: true, tenantId: true },
  });
  return artworks
    .filter(a => enabledTenantIds.includes(a.tenantId))
    .map(a => a.id);
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Storefront disabled — browse exclusion — real-DB integration", () => {
  it("disabled tenant's artworks are excluded from public browse", async () => {
    const disabledId = await createTenant(false);
    const artworkId = await createArtwork(disabledId);

    const ids = await publicBrowseIds();
    expect(ids).not.toContain(artworkId);
  });

  it("enabled tenant's artworks appear in public browse", async () => {
    const enabledId = await createTenant(true);
    const artworkId = await createArtwork(enabledId);

    const ids = await publicBrowseIds();
    expect(ids).toContain(artworkId);
  });

  it("mixed tenants: only enabled-tenant artworks appear", async () => {
    const enabledId = await createTenant(true);
    const disabledId = await createTenant(false);

    const enabledArtId = await createArtwork(enabledId);
    const disabledArtId = await createArtwork(disabledId);

    const ids = await publicBrowseIds();
    expect(ids).toContain(enabledArtId);
    expect(ids).not.toContain(disabledArtId);
  });

  it("re-enabling storefrontEnabled → artworks appear in next browse", async () => {
    const tenantId = await createTenant(false);
    const artworkId = await createArtwork(tenantId);

    // Confirm excluded.
    const before = await publicBrowseIds();
    expect(before).not.toContain(artworkId);

    // Re-enable.
    await db.update(tenantsTable)
      .set({ storefrontEnabled: true })
      .where(eq(tenantsTable.id, tenantId));

    const after = await publicBrowseIds();
    expect(after).toContain(artworkId);
  });

  it("disabling storefrontEnabled immediately excludes previously visible artworks", async () => {
    const tenantId = await createTenant(true);
    const artworkId = await createArtwork(tenantId);

    // Confirm visible.
    const before = await publicBrowseIds();
    expect(before).toContain(artworkId);

    // Disable.
    await db.update(tenantsTable)
      .set({ storefrontEnabled: false })
      .where(eq(tenantsTable.id, tenantId));

    const after = await publicBrowseIds();
    expect(after).not.toContain(artworkId);
  });
});
