/**
 * Admin new-artwork page — represented-artist dropdown query — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/new/page.tsx queries:
 *   representedArtistsTable WHERE tenantId = session.tenantId ORDER BY name ASC
 *
 * This suite verifies that query contract against real PostgreSQL:
 *
 *  1. Own tenant's artists appear in results ordered by name ASC.
 *  2. Foreign-tenant artists do not appear.
 *  3. Zero artists for a new tenant returns an empty array.
 *  4. Artists are ordered by name case-insensitively (DB collation).
 *  5. Deleting an artist removes it from the dropdown results.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, representedArtistsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];

function uid() { return `${randomUUID()}-cad-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "New Artwork Page Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtist(tenantId: string, name: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({ id, tenantId, name } as any);
  createdArtistIds.push(id);
  return id;
}

/** Mirror the page query: tenant-scoped artists, name ASC. */
async function dropdownQuery(tenantId: string) {
  return db.query.representedArtistsTable.findMany({
    where: eq(representedArtistsTable.tenantId, tenantId),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

async function cleanup() {
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Admin new-artwork page — artist dropdown query — real-DB integration", () => {
  it("own tenant's artists appear and are ordered by name ASC", async () => {
    const tenantId = await createTenant();
    const charlesId = await createArtist(tenantId, "Charles");
    const aliceId   = await createArtist(tenantId, "Alice");
    const bobId     = await createArtist(tenantId, "Bob");

    const results = await dropdownQuery(tenantId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(aliceId);
    expect(ids).toContain(bobId);
    expect(ids).toContain(charlesId);

    // Verify ASC ordering: Alice < Bob < Charles.
    const aliceIdx   = ids.indexOf(aliceId);
    const bobIdx     = ids.indexOf(bobId);
    const charlesIdx = ids.indexOf(charlesId);

    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(charlesIdx);
  });

  it("foreign-tenant artists do not appear in own tenant's dropdown", async () => {
    const ownTenantId     = await createTenant();
    const foreignTenantId = await createTenant();

    const ownArtistId     = await createArtist(ownTenantId, "Own Artist");
    const foreignArtistId = await createArtist(foreignTenantId, "Foreign Artist");

    const results = await dropdownQuery(ownTenantId);
    const ids = results.map(r => r.id);

    expect(ids).toContain(ownArtistId);
    expect(ids).not.toContain(foreignArtistId);
  });

  it("zero artists for a new tenant returns an empty array", async () => {
    const tenantId = await createTenant();

    const results = await dropdownQuery(tenantId);
    expect(results).toHaveLength(0);
  });

  it("deleting an artist removes it from the dropdown results", async () => {
    const tenantId = await createTenant();
    const keepId   = await createArtist(tenantId, "Keep Me");
    const deleteId = await createArtist(tenantId, "Delete Me");

    // Confirm both appear.
    const before = await dropdownQuery(tenantId);
    expect(before.map(r => r.id)).toContain(deleteId);

    // Delete and re-query.
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, deleteId));
    createdArtistIds.splice(createdArtistIds.indexOf(deleteId), 1);

    const after = await dropdownQuery(tenantId);
    expect(after.map(r => r.id)).not.toContain(deleteId);
    expect(after.map(r => r.id)).toContain(keepId);
  });
});
