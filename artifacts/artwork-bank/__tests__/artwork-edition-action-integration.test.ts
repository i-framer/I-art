/**
 * Artwork isEdition / editionNumber / totalEditions — action-level — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:
 *   createArtwork / updateArtwork parse isEdition from "on"/"off", editionNumber,
 *   and totalEditions from the form and persist them via toInsertValues().
 *
 * Existing `artwork-edition-fields-integration.test.ts` tests direct DB inserts;
 * this suite exercises the actual action path.
 *
 *  1. createArtwork with isEdition=on persists isEdition=true.
 *  2. createArtwork without isEdition persists isEdition=false.
 *  3. updateArtwork sets isEdition=true with editionNumber and totalEditions.
 *  4. updateArtwork clears edition fields by omitting them.
 *  5. editionNumber and totalEditions are independent (one set, one null).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoryOnArtworkTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-aeai-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-edition-action", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { createArtwork, updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Edition Action Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function insertArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Edition Action Art", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fdCreate(extras: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Edition Action Art");
  f.set("sku", `sku-${uid()}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) f.set(k, v);
  return f;
}

function fdUpdate(artworkId: string, extras: Record<string, string> = {}) {
  const f = new FormData();
  f.set("title", "Edition Action Art");
  f.set("sku", `sku-${artworkId}`);
  f.set("status", "AVAILABLE");
  f.set("price", "");
  for (const [k, v] of Object.entries(extras)) f.set(k, v);
  return f;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
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

describeIntegration("Artwork edition fields — action-level — real-DB integration", () => {
  it("createArtwork with isEdition=on persists isEdition=true", async () => {
    const { tenantId } = await createTenant();

    let redirectUrl = "";
    await createArtwork({ error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdCreate({ isEdition: "on", editionNumber: "3", totalEditions: "10" }))
      .catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("created=1");

    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    const created = rows.find(r => r.isEdition === true);
    if (created) createdArtworkIds.push(created.id);
    expect(created?.isEdition).toBe(true);
    expect(created?.editionNumber).toBe(3);
    expect(created?.totalEditions).toBe(10);
  });

  it("createArtwork without isEdition persists isEdition=false", async () => {
    const { tenantId } = await createTenant();

    let redirectUrl = "";
    await createArtwork({ error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdCreate())
      .catch(e => { redirectUrl = String(e); });

    expect(redirectUrl).toContain("created=1");

    const rows = await db.query.artworksTable.findMany({
      where: eq(artworksTable.tenantId, tenantId),
    });
    const created = rows[rows.length - 1];
    if (created) createdArtworkIds.push(created.id);
    expect(created?.isEdition).toBe(false);
  });

  it("updateArtwork sets isEdition=true with editionNumber and totalEditions", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);

    await updateArtwork(artworkId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdUpdate(artworkId, {
      isEdition: "on",
      editionNumber: "5",
      totalEditions: "20",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.isEdition).toBe(true);
    expect(row?.editionNumber).toBe(5);
    expect(row?.totalEditions).toBe(20);
  });

  it("updateArtwork clears edition fields by omitting them", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);

    // First set edition fields.
    await updateArtwork(artworkId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdUpdate(artworkId, {
      isEdition: "on", editionNumber: "2", totalEditions: "8",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Clear by omitting.
    await updateArtwork(artworkId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdUpdate(artworkId))
      .catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.isEdition).toBe(false);
    expect(row?.editionNumber).toBeNull();
    expect(row?.totalEditions).toBeNull();
  });

  it("editionNumber and totalEditions are independent (one set, one null)", async () => {
    const { tenantId } = await createTenant();
    const artworkId   = await insertArtwork(tenantId);

    // Only set editionNumber, not totalEditions.
    await updateArtwork(artworkId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fdUpdate(artworkId, {
      isEdition: "on", editionNumber: "7",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, artworkId) });
    expect(row?.editionNumber).toBe(7);
    expect(row?.totalEditions).toBeNull();
  });
});
