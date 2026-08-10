/**
 * lookupOrder (public storefront) — real-DB integration.
 *
 * `order-lookup-auth.test.ts` uses an in-memory DB mock.  This integration
 * suite verifies the lookup logic against real PostgreSQL:
 *
 *  1. Valid email + 8-char prefix → order found with correct fields.
 *  2. Lookup is case-insensitive for both email and ref prefix.
 *  3. Wrong email → not_found (no cross-tenant/cross-user leakage).
 *  4. Wrong ref prefix → not_found.
 *  5. Cross-tenant slug → not_found (tenant isolation).
 *  6. artworkTitle is null when the order has no items.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Rate limit — always pass through ─────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99 })),
  resetRateLimiter: vi.fn(async () => {}),
}));

// ── next/headers ──────────────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

import { lookupOrder } from "@/app/t/[slug]/orders/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdOrderIds: string[] = [];

function uid() { return `${randomUUID()}-lkup-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  const slug = `slug-${id.slice(0, 8)}`;
  await db.insert(tenantsTable).values({
    id, slug, businessName: "Lookup Order Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Lookup Test Artwork", sku: `sku-${id}`,
    status: "SOLD", showInGallery: false,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createOrder(tenantId: string, buyerEmail: string) {
  const id = uid();
  await db.insert(ordersTable).values({
    id, tenantId,
    buyerEmail,
    buyerName: "Test Buyer",
    totalCents: 10000,
    status: "PAID",
    fulfillmentType: "PICKUP",
  } as any);
  createdOrderIds.push(id);
  return id;
}

async function addOrderItem(orderId: string, artworkId: string, tenantId: string) {
  await db.insert(orderItemsTable).values({
    id: uid(), orderId, artworkId, tenantId,
    artworkTitle: "Lookup Test Artwork",
    priceCents: 10000,
  } as any);
}

async function cleanup() {
  for (const id of createdOrderIds.splice(0)) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("lookupOrder (public storefront) — real-DB integration", () => {
  it("valid email + 8-char prefix → order found with correct fields", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, "buyer@example.com");
    await addOrderItem(orderId, artworkId, tenantId);

    const ref = orderId.slice(0, 8);

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref }),
    );

    expect(result.status).toBe("found");
    expect(result.order).not.toBeNull();
    expect(result.order!.orderStatus).toBe("PAID");
    expect(result.order!.fulfillmentType).toBe("PICKUP");
    expect(result.order!.artworkTitle).toBe("Lookup Test Artwork");
    expect(result.order!.ref).toBe(ref.toUpperCase());
  });

  it("lookup is case-insensitive for email and ref prefix", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, "BUYER@EXAMPLE.COM");
    await addOrderItem(orderId, artworkId, tenantId);

    const ref = orderId.slice(0, 8).toUpperCase();

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: ref.toLowerCase() }),
    );

    expect(result.status).toBe("found");
  });

  it("wrong email → not_found", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, "real@buyer.com");
    await addOrderItem(orderId, artworkId, tenantId);

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "wrong@buyer.com", ref: orderId.slice(0, 8) }),
    );

    expect(result.status).toBe("not_found");
    expect(result.order).toBeNull();
  });

  it("wrong ref prefix → not_found", async () => {
    const { tenantId, slug } = await createTenant();
    const _orderId = await createOrder(tenantId, "buyer@example.com");

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: "00000000" }),
    );

    expect(result.status).toBe("not_found");
  });

  it("cross-tenant slug → not_found (tenant isolation)", async () => {
    const { tenantId } = await createTenant();
    const orderId = await createOrder(tenantId, "buyer@example.com");

    const { slug: otherSlug } = await createTenant();

    const result = await lookupOrder(
      otherSlug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: orderId.slice(0, 8) }),
    );

    expect(result.status).toBe("not_found");
  });

  it("ref shorter than 8 hex chars → validation error returned (Task #48)", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const orderId = await createOrder(tenantId, "buyer@example.com");
    await addOrderItem(orderId, artworkId, tenantId);

    // The action validates ^[0-9a-fA-F]{8}$ — 7 chars fails Zod, returns 'error'
    // rather than leaking a partial match via 'not_found'.
    const shortRef = orderId.slice(0, 7);

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: shortRef }),
    );

    expect(result.status).toBe("error");
    expect(result.order).toBeNull();
    // Error message must NOT reveal whether the order exists.
    expect(result.error).not.toMatch(/found|exist/i);
  });

  it("empty ref → validation error returned (enumeration protection)", async () => {
    const { tenantId, slug } = await createTenant();
    await createOrder(tenantId, "buyer@example.com");

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: "" }),
    );

    expect(result.status).toBe("error");
    expect(result.order).toBeNull();
  });

  it("order with no items → artworkTitle is null", async () => {
    const { tenantId, slug } = await createTenant();
    const orderId = await createOrder(tenantId, "buyer@example.com");
    // No order items added.

    const result = await lookupOrder(
      slug,
      { status: "idle", error: "", order: null },
      fd({ email: "buyer@example.com", ref: orderId.slice(0, 8) }),
    );

    expect(result.status).toBe("found");
    expect(result.order!.artworkTitle).toBeNull();
  });
});
