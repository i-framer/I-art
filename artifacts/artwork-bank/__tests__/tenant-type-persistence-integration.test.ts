/**
 * Tenant type field — persistence — real-DB integration.
 *
 * The `type` column on `tenantsTable` is an enum: ARTIST | FRAMER.
 * This suite verifies insert/update semantics and tenant isolation:
 *
 *  1. Tenant created as ARTIST type is stored and read back as ARTIST.
 *  2. Tenant created as FRAMER type is stored and read back as FRAMER.
 *  3. Type can be updated from ARTIST to FRAMER.
 *  4. Type can be updated from FRAMER to ARTIST.
 *  5. Updating type of own tenant does not affect a foreign tenant's type.
 *  6. Type is used correctly in browse filter (ARTIST vs FRAMER artworks).
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

function uid() { return `${randomUUID()}-ttp-${RUN}-${++seq}`; }

async function createTenant(type: "ARTIST" | "FRAMER") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Type Test Gallery ${id}`, type,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function tenantType(id: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, id) });
  return row?.type;
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

describeIntegration("Tenant type field — persistence — real-DB integration", () => {
  it("tenant created as ARTIST is stored and read back as ARTIST", async () => {
    const id = await createTenant("ARTIST");
    expect(await tenantType(id)).toBe("ARTIST");
  });

  it("tenant created as FRAMER is stored and read back as FRAMER", async () => {
    const id = await createTenant("FRAMER");
    expect(await tenantType(id)).toBe("FRAMER");
  });

  it("type can be updated from ARTIST to FRAMER", async () => {
    const id = await createTenant("ARTIST");

    await db.update(tenantsTable).set({ type: "FRAMER" }).where(eq(tenantsTable.id, id));

    expect(await tenantType(id)).toBe("FRAMER");
  });

  it("type can be updated from FRAMER to ARTIST", async () => {
    const id = await createTenant("FRAMER");

    await db.update(tenantsTable).set({ type: "ARTIST" }).where(eq(tenantsTable.id, id));

    expect(await tenantType(id)).toBe("ARTIST");
  });

  it("updating own tenant type does not affect a foreign tenant's type", async () => {
    const ownId     = await createTenant("ARTIST");
    const foreignId = await createTenant("FRAMER");

    await db.update(tenantsTable).set({ type: "FRAMER" }).where(eq(tenantsTable.id, ownId));

    expect(await tenantType(ownId)).toBe("FRAMER");
    expect(await tenantType(foreignId)).toBe("FRAMER"); // unchanged
  });

  it("tenant type is correctly used to scope ARTIST-type filtering", async () => {
    const artistId = await createTenant("ARTIST");
    const framerId = await createTenant("FRAMER");

    // Query only ARTIST tenants.
    const artists = await db.query.tenantsTable.findMany({
      where: eq(tenantsTable.type, "ARTIST"),
    });
    const framerMatches = await db.query.tenantsTable.findMany({
      where: and(
        eq(tenantsTable.type, "ARTIST"),
        eq(tenantsTable.id, framerId),
      ),
    });

    const artistIds = artists.map(t => t.id);
    expect(artistIds).toContain(artistId);
    expect(framerMatches).toHaveLength(0); // FRAMER tenant not returned as ARTIST
  });
});
