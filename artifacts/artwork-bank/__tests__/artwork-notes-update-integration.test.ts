/**
 * Artwork notes field — update persistence — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:35,65,90 includes `notes` in
 * the artwork form schema, extracted via parseArtworkFormData, and written
 * via toInsertValues (null when empty).
 *
 * This suite verifies notes update/read-back at the DB layer via the
 * updateArtwork action:
 *
 *  1. Notes value is persisted on update.
 *  2. Notes update overwrites a previous value.
 *  3. Clearing notes (empty string) stores null.
 *  4. Notes are not written to a foreign tenant's artwork.
 *  5. Notes persist independently from other fields (title unchanged).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, usersTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-anu-${RUN}-${++seq}`; }

// ── Auth / billing / next ────────────────────────────────────────────────────
const mockSession = { value: { userId: "u-notes-test", tenantId: "PLACEHOLDER", role: "owner" } };

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

import { updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

// ── DB helpers ───────────────────────────────────────────────────────────────
async function createTenant() {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `user-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Notes Update Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string, notes?: string | null) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Notes Test Art", sku: `sku-${id}`,
    status: "AVAILABLE", notes: notes ?? null,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function artworkNotes(id: string) {
  const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
  return row?.notes ?? null;
}

async function cleanup() {
  for (const id of createdArtworkIds.splice(0)) {
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

describeIntegration("Artwork notes field — update persistence — real-DB integration", () => {
  it("notes value is persisted on update", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, null);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Notes Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      notes: "This is a charcoal drawing on archival paper.",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkNotes(id)).toBe("This is a charcoal drawing on archival paper.");
  });

  it("notes update overwrites a previous value", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, "Old notes.");

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Notes Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      notes: "Updated notes — acrylic on canvas.",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkNotes(id)).toBe("Updated notes — acrylic on canvas.");
  });

  it("clearing notes (empty string) stores null", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, "Some existing notes.");

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Notes Test Art", sku: `sku-${id}`, status: "AVAILABLE",
      notes: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    expect(await artworkNotes(id)).toBeNull();
  });

  it("notes are not written to a foreign tenant's artwork", async () => {
    const { tenantId: _ownTenantId } = await createTenant();

    // Create a foreign artwork using direct DB insert (bypasses auth).
    const foreignTenantId = uid();
    await db.insert(tenantsTable).values({
      id: foreignTenantId, slug: foreignTenantId,
      businessName: "Foreign Notes Gallery", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignTenantId);
    const foreignId = uid();
    await db.insert(artworksTable).values({
      id: foreignId, tenantId: foreignTenantId, title: "Foreign Art",
      sku: `sku-${foreignId}`, status: "AVAILABLE", notes: "Foreign notes.",
    } as any);
    createdArtworkIds.push(foreignId);

    // Attempt to update foreign artwork from own session.
    const result = await updateArtwork(foreignId, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Foreign Art", sku: `sku-${foreignId}`, status: "AVAILABLE",
      notes: "Overwritten!",
    }));

    expect(result).toEqual({ error: "Artwork not found." });
    // Foreign artwork notes must be unchanged.
    expect(await artworkNotes(foreignId)).toBe("Foreign notes.");
  });

  it("notes persist independently from other fields (title unchanged after notes update)", async () => {
    const { tenantId } = await createTenant();
    const id = await createArtwork(tenantId, null);

    await updateArtwork(id, { error: "" } as import("@/app/(admin)/(gated)/catalog/actions").ArtworkFormState, fd({
      title: "Stable Title", sku: `sku-${id}`, status: "AVAILABLE",
      notes: "Added notes.",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) });
    expect(row?.notes).toBe("Added notes.");
    expect(row?.title).toBe("Stable Title");
  });
});
