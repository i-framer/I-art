/**
 * updateArtwork notes field persistence — real-DB integration.
 *
 * app/(admin)/(gated)/catalog/actions.ts:142-202 (updateArtwork):
 *   Notes field is an optional text field persisted on artworksTable.
 *
 *  1. Update artwork notes → notes value persisted in DB.
 *  2. Update notes to empty string → notes cleared (null or empty).
 *  3. Update notes on a different tenant's artwork → no-op (no change).
 *  4. Original notes replaced when updated again.
 *  5. Artwork without notes → notes remain null after unrelated update.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-auni-${RUN}-${++seq}`; }

const mockSession: { value: { userId: string; tenantId: string; role: string } } = {
  value: { userId: "u-notes", tenantId: "PLACEHOLDER", role: "owner" },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { updateArtwork } from "@/app/(admin)/(gated)/catalog/actions";

function makeForm(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const INITIAL_STATE = { error: "" };

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Notes Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  mockSession.value = { userId: `u-${id}`, tenantId: id, role: "owner" };
  return id;
}

async function createArtwork(tenantId: string, notes?: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Notes Test Art", sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery: true,
    notes: notes ?? null,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

function artworkForm(overrides: Record<string, string> = {}) {
  return makeForm({
    title: "Notes Test Art",
    sku: `sku-${uid()}`,
    price: "100",
    status: "AVAILABLE",
    ...overrides,
  });
}

async function getArtworkNotes(id: string) {
  return (await db.query.artworksTable.findFirst({ where: eq(artworksTable.id, id) }))?.notes;
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

describeIntegration("updateArtwork notes field persistence — real-DB integration", () => {
  it("update artwork notes → notes value persisted in DB", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId);

    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ notes: "Private note for gallery owner" })).catch(() => {});

    expect(await getArtworkNotes(artworkId)).toBe("Private note for gallery owner");
  });

  it("update notes to empty string → notes cleared (null or empty)", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "Original note");

    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ notes: "" })).catch(() => {});

    const notes = await getArtworkNotes(artworkId);
    // Accepted: null or empty string — both represent "cleared".
    expect(notes == null || notes === "").toBe(true);
  });

  it("original notes replaced when updated again", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId, "Old note");

    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ notes: "Updated note" })).catch(() => {});
    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ notes: "Final note" })).catch(() => {});

    expect(await getArtworkNotes(artworkId)).toBe("Final note");
  });

  it("update on different tenant's artwork → no change (tenant scope)", async () => {
    const tenantA   = await createTenant();
    const artworkId = await createArtwork(tenantA, "Tenant A note");

    // Switch to tenant B.
    const tenantB = await createTenant();
    mockSession.value = { userId: `u-${tenantB}`, tenantId: tenantB, role: "owner" };

    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ notes: "Tenant B hijack" })).catch(() => {});

    // Tenant A's artwork notes should be unchanged.
    expect(await getArtworkNotes(artworkId)).toBe("Tenant A note");
  });

  it("artwork without notes → notes remain null after price update", async () => {
    const tenantId  = await createTenant();
    const artworkId = await createArtwork(tenantId); // no notes

    // Update only price, no notes field.
    await updateArtwork(artworkId, INITIAL_STATE, artworkForm({ price: "200" })).catch(() => {});

    expect(await getArtworkNotes(artworkId)).toBeNull();
  });
});
