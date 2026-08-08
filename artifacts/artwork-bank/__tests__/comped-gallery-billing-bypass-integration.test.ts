/**
 * Comped galleries — billing bypass — real-DB integration.
 *
 * Task #88: "Confirm comped galleries skip the paywall end-to-end on a real database."
 *
 * requireActiveBillingAccess queries the DB for billingExempt/subscriptionStatus.
 * This suite verifies against real PostgreSQL that the DB-level guard passes for
 * comped tenants and blocks for unsubscribed tenants:
 *
 *  1. billingExempt=true, subscriptionStatus=null → createArtwork succeeds.
 *  2. billingExempt=true, subscriptionStatus="canceled" → createArtwork succeeds.
 *  3. billingExempt=false, subscriptionStatus=null → createArtwork throws "Subscription required".
 *  4. billingExempt=false, subscriptionStatus="active" → createArtwork succeeds.
 *  5. createCategory works for comped tenant (shows broad guard coverage).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  artworkCategoriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth ──────────────────────────────────────────────────────────────────────
const mockSession = { userId: "u-comped-owner", tenantId: "PLACEHOLDER", role: "owner" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

// DO NOT mock requireActiveBillingAccess — we need the real DB query.

// ── Other deps ────────────────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  uploadArtworkImage: vi.fn(async () => "https://cdn.example.com/image.jpg"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createArtwork } from "@/app/(admin)/(gated)/catalog/actions";
import { createCategory } from "@/app/(admin)/(gated)/catalog/categories/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdCategoryIds: string[] = [];

function uid() { return `${randomUUID()}-comp-${RUN}-${++seq}`; }

async function createTenant(opts: {
  billingExempt: boolean;
  subscriptionStatus: string | null;
}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id,
    businessName: "Comped Test Gallery",
    type: "ARTIST",
    billingExempt: opts.billingExempt,
    subscriptionStatus: opts.subscriptionStatus,
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function cleanup() {
  for (const id of createdCategoryIds.splice(0)) {
    await db.delete(artworkCategoriesTable).where(eq(artworkCategoriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function artworkFd(tenantId: string) {
  const f = new FormData();
  f.set("title", `Artwork ${uid()}`);
  f.set("sku", `sku-${uid()}`);
  f.set("status", "AVAILABLE");
  f.set("price", "10000");
  f.set("tenantId", tenantId);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Comped galleries — billing bypass — real-DB integration", () => {
  it("billingExempt=true, subscriptionStatus=null → createArtwork succeeds", async () => {
    const tenantId = await createTenant({ billingExempt: true, subscriptionStatus: null });

    let thrown: Error | null = null;
    try {
      await createArtwork({ success: false, errors: {}, artworkId: null }, artworkFd(tenantId));
    } catch (e: any) {
      if (e?.message === "Subscription required") thrown = e;
      // redirect() is thrown from createArtwork on success — that's fine
    }

    expect(thrown).toBeNull();
  });

  it("billingExempt=true, subscriptionStatus='canceled' → createArtwork succeeds", async () => {
    const tenantId = await createTenant({ billingExempt: true, subscriptionStatus: "canceled" });

    let thrown: Error | null = null;
    try {
      await createArtwork({ success: false, errors: {}, artworkId: null }, artworkFd(tenantId));
    } catch (e: any) {
      if (e?.message === "Subscription required") thrown = e;
    }

    expect(thrown).toBeNull();
  });

  it("billingExempt=false, subscriptionStatus=null → throws Subscription required", async () => {
    await createTenant({ billingExempt: false, subscriptionStatus: null });

    await expect(
      createArtwork({ success: false, errors: {}, artworkId: null }, artworkFd(mockSession.tenantId)),
    ).rejects.toThrow("Subscription required");
  });

  it("billingExempt=false, subscriptionStatus='active' → createArtwork succeeds", async () => {
    const tenantId = await createTenant({ billingExempt: false, subscriptionStatus: "active" });

    let thrown: Error | null = null;
    try {
      await createArtwork({ success: false, errors: {}, artworkId: null }, artworkFd(tenantId));
    } catch (e: any) {
      if (e?.message === "Subscription required") thrown = e;
    }

    expect(thrown).toBeNull();
  });

  it("createCategory: comped gallery (billingExempt=true) succeeds", async () => {
    const tenantId = await createTenant({ billingExempt: true, subscriptionStatus: null });

    const f = new FormData();
    f.set("name", `Category ${uid()}`);

    let thrown: Error | null = null;
    try {
      await createCategory({ success: false, error: "" }, f);
    } catch (e: any) {
      if (e?.message === "Subscription required") thrown = e;
    }

    expect(thrown).toBeNull();

    // Verify the category was actually inserted.
    const rows = await db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, tenantId),
    });
    if (rows.length > 0) createdCategoryIds.push(...rows.map(r => r.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
