/**
 * updateRepresentedArtist — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/artists/actions.ts:45-79 (updateRepresentedArtist):
 *   Updates name, bio, commissionPct scoped to the session tenant.
 *
 *  1. Update name → name persisted.
 *  2. Update commissionPct → new value persisted.
 *  3. Update bio → bio persisted.
 *  4. Clear bio (empty string) → bio set to null.
 *  5. Foreign tenant's artist → no change (tenant scope protects it).
 *  6. All fields updated together → all values reflected correctly.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, representedArtistsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtistIds: string[] = [];

function uid() { return `${randomUUID()}-raui-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-artist-update", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

import { updateRepresentedArtist } from "@/app/(admin)/(gated)/catalog/artists/actions";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Artist Update Test", type: "ARTIST",
  } as any);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  createdTenantIds.push(id);
  return id;
}

async function createArtist(tenantId: string, opts: { name?: string; bio?: string; commissionPct?: number } = {}) {
  const [row] = await db.insert(representedArtistsTable).values({
    tenantId, name: opts.name ?? "Original Name",
    bio: opts.bio ?? "Original bio",
    commissionPct: opts.commissionPct ?? 10,
  } as any).returning();
  createdArtistIds.push(row!.id);
  return row!.id;
}

async function getArtist(id: string) {
  return db.query.representedArtistsTable.findFirst({ where: eq(representedArtistsTable.id, id) });
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

const INIT = { error: "" };

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("updateRepresentedArtist — real-DB integration", () => {
  it("update name → new name persisted", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId);

    await updateRepresentedArtist(artistId, INIT, fd({ name: "Updated Name", commissionPct: "10" }));

    expect((await getArtist(artistId))?.name).toBe("Updated Name");
  });

  it("update commissionPct → new value persisted", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId, { commissionPct: 10 });

    await updateRepresentedArtist(artistId, INIT, fd({ name: "Artist", commissionPct: "25" }));

    expect((await getArtist(artistId))?.commissionPct).toBe(25);
  });

  it("update bio → bio persisted", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId);

    await updateRepresentedArtist(artistId, INIT, fd({ name: "Artist", bio: "New bio text", commissionPct: "0" }));

    expect((await getArtist(artistId))?.bio).toBe("New bio text");
  });

  it("clear bio (empty string) → bio set to null", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId, { bio: "Existing bio" });

    // Empty bio string → cleared (bio || undefined → undefined → null stored).
    await updateRepresentedArtist(artistId, INIT, fd({ name: "Artist", bio: "", commissionPct: "0" }));

    expect((await getArtist(artistId))?.bio ?? null).toBeNull();
  });

  it("foreign tenant's artist → no change (tenant scope protects it)", async () => {
    const tenantA  = await createTenant();
    const artistId = await createArtist(tenantA, { name: "Tenant A Artist", commissionPct: 10 });

    // Switch session to tenant B.
    const tenantB  = await createTenant();
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    await updateRepresentedArtist(artistId, INIT, fd({ name: "Hijacked", commissionPct: "99" }));

    // Tenant A's artist should be unchanged.
    const artist = await getArtist(artistId);
    expect(artist?.name).toBe("Tenant A Artist");
    expect(artist?.commissionPct).toBe(10);
  });

  it("all fields updated together → all values reflected correctly", async () => {
    const tenantId  = await createTenant();
    const artistId  = await createArtist(tenantId, { name: "Old", bio: "Old bio", commissionPct: 5 });

    await updateRepresentedArtist(
      artistId, INIT,
      fd({ name: "New Name", bio: "New bio", commissionPct: "30" }),
    );

    const artist = await getArtist(artistId);
    expect(artist?.name).toBe("New Name");
    expect(artist?.bio).toBe("New bio");
    expect(artist?.commissionPct).toBe(30);
  });
});
