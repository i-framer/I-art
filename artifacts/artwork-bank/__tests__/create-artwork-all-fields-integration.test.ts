/**
 * createArtwork — all optional fields at once — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts: createArtwork(prevState, formData).
 * Persists: title, sku, status, showInGallery, price, medium, dimensionsW/H/D,
 *           condition, editionNumber, totalEditions, notes, representedArtistId.
 *
 *  1. All optional fields are persisted in a single createArtwork call.
 *  2. Dimension values are stored as integers (mm).
 *  3. Edition fields are only set when isEdition=true.
 *  4. Edition fields are null when isEdition is absent.
 *  5. notes field is persisted.
 *  6. representedArtistId is persisted and links to an artist row.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoryOnArtworkTable,
  representedArtistsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdArtistIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-caafi-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-all-fields", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { createArtwork } from "@/app/(admin)/(gated)/catalog/actions";

async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "All Fields Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function createArtist(tenantId: string) {
  const id = uid();
  await db.insert(representedArtistsTable).values({
    id, tenantId, name: "All Fields Artist",
  } as any);
  createdArtistIds.push(id);
  return id;
}

async function latestArtwork(tenantId: string) {
  const rows = await db.query.artworksTable.findMany({ where: eq(artworksTable.tenantId, tenantId) });
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const row = rows[0];
  if (row) createdArtworkIds.push(row.id);
  return row;
}

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworkCategoryOnArtworkTable)
      .where(eq(artworkCategoryOnArtworkTable.artworkId, id)).catch(() => {});
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdArtistIds.splice(0)) {
    await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
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

describeIntegration("createArtwork — all optional fields — real-DB integration", () => {
  it("all optional fields are persisted in a single createArtwork call", async () => {
    const { tenantId } = await createTenant();

    await createArtwork({ error: "" }, fd({
      title: "Full Field Art", sku: `sku-full-${uid()}`, status: "AVAILABLE",
      price: "250", medium: "Oil on canvas",
      dimensionsW: "600", dimensionsH: "900", dimensionsD: "20",
      condition: "GOOD", notes: "Private admin note",
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.title).toBe("Full Field Art");
    expect(art?.medium).toBe("Oil on canvas");
    expect(art?.dimensionsW).toBe(600);
    expect(art?.dimensionsH).toBe(900);
    expect(art?.dimensionsD).toBe(20);
    expect(art?.condition).toBe("GOOD");
    expect(art?.notes).toBe("Private admin note");
    expect(art?.price).toBe(25000); // dollars → cents
  });

  it("dimension values are stored as integers (mm)", async () => {
    const { tenantId } = await createTenant();

    await createArtwork({ error: "" }, fd({
      title: "Dimensions Art", sku: `sku-dim-${uid()}`, status: "AVAILABLE",
      dimensionsW: "450", dimensionsH: "600", dimensionsD: "15",
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.dimensionsW).toBe(450);
    expect(art?.dimensionsH).toBe(600);
    expect(art?.dimensionsD).toBe(15);
  });

  it("edition fields are set when isEdition=true", async () => {
    const { tenantId } = await createTenant();

    await createArtwork({ error: "" }, fd({
      title: "Edition Art", sku: `sku-ed-${uid()}`, status: "AVAILABLE",
      isEdition: "on", editionNumber: "3", totalEditions: "10",
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.editionNumber).toBe(3);
    expect(art?.totalEditions).toBe(10);
  });

  it("edition fields are null when isEdition is absent", async () => {
    const { tenantId } = await createTenant();

    await createArtwork({ error: "" }, fd({
      title: "Non Edition Art", sku: `sku-ned-${uid()}`, status: "AVAILABLE",
      editionNumber: "3", totalEditions: "10", // supplied but no isEdition flag
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.editionNumber).toBeNull();
    expect(art?.totalEditions).toBeNull();
  });

  it("notes field is persisted", async () => {
    const { tenantId } = await createTenant();

    await createArtwork({ error: "" }, fd({
      title: "Notes Art", sku: `sku-notes-${uid()}`, status: "AVAILABLE",
      notes: "Keep this piece away from direct sunlight.",
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.notes).toBe("Keep this piece away from direct sunlight.");
  });

  it("representedArtistId is persisted and links to an artist row", async () => {
    const { tenantId } = await createTenant();
    const artistId = await createArtist(tenantId);

    await createArtwork({ error: "" }, fd({
      title: "Artist Linked Art", sku: `sku-artist-${uid()}`, status: "AVAILABLE",
      representedArtistId: artistId,
    })).catch((e: Error) => { if (!e.message.startsWith("REDIRECT:")) throw e; });

    const art = await latestArtwork(tenantId);
    expect(art?.representedArtistId).toBe(artistId);
  });
});
