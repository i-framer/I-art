/**
 * submitInquiry action — end-to-end real-DB integration.
 *
 * app/t/[slug]/[artworkId]/actions.ts:28-128:
 *   Validates formData (name, email, message).
 *   Guards: tenant not found, no contactEmail, artwork not found/hidden.
 *   On success: inserts inquiriesTable row, sends email.
 *   Returns { status: "sent" } on success.
 *
 *  1. Valid submission → inquiriesTable row inserted with correct fields.
 *  2. Valid submission → returns { status: "sent" }.
 *  3. Missing tenant (unknown slug) → returns error status, no DB row.
 *  4. Tenant with no contactEmail → returns error status, no DB row.
 *  5. Artwork with showInGallery=false → returns error status, no DB row.
 *  6. Valid submission → artworkTitle and tenantId denormalized onto inquiry row.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db, tenantsTable, artworksTable, inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];

function uid() { return `${randomUUID()}-siai-${RUN}-${++seq}`; }

vi.mock("@/lib/email", () => ({
  sendArtworkInquiry: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) => {
    return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  }),
}));
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(() => "https://example.com/artwork"),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "127.0.0.1" })),
}));

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

const INITIAL_STATE = { status: "idle" as const, error: "" };

function makeForm(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function createTenant(opts: { contactEmail?: string | null } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: `Inquiry Gallery ${seq}`, type: "ARTIST",
    storefrontEnabled: true,
    contactEmail: opts.contactEmail === undefined ? `gallery-${id}@test.com` : opts.contactEmail,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, showInGallery = true) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: `Inquiry Artwork ${seq}`, sku: `sku-${id}`,
    status: "AVAILABLE", price: 10000, showInGallery,
  } as any);
  createdArtworkIds.push(id);
  return { artworkId: id };
}

async function cleanup() {
  for (const artworkId of createdArtworkIds) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.artworkId, artworkId)).catch(() => {});
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

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("submitInquiry action — end-to-end real-DB integration", () => {
  it("valid submission → inquiriesTable row inserted with correct fields", async () => {
    const { slug, tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId);
    const form = makeForm({ name: "Alice Buyer", email: "alice@test.com", message: "Is it still available?" });

    await submitInquiry(slug, artworkId, INITIAL_STATE, form);

    const row = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(row).not.toBeUndefined();
    expect(row?.buyerName).toBe("Alice Buyer");
    expect(row?.buyerEmail).toBe("alice@test.com");
    expect(row?.message).toBe("Is it still available?");
  });

  it("valid submission → returns { status: 'sent' }", async () => {
    const { slug, tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId);
    const form = makeForm({ name: "Bob", email: "bob@test.com", message: "Interested!" });

    const result = await submitInquiry(slug, artworkId, INITIAL_STATE, form);

    expect(result.status).toBe("sent");
  });

  it("missing tenant (unknown slug) → returns error, no DB row", async () => {
    const { tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId);
    const form = makeForm({ name: "X", email: "x@test.com", message: "Hi" });

    // Use an unknown slug — tenant lookup will return undefined.
    const result = await submitInquiry(`unknown-slug-${uid()}`, artworkId, INITIAL_STATE, form);

    expect(result.status).toBe("error");
    const rows = await db.query.inquiriesTable.findMany({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(rows).toHaveLength(0);
  });

  it("tenant with no contactEmail → returns error, no DB row", async () => {
    const { slug, tenantId } = await createTenant({ contactEmail: null });
    const { artworkId } = await createArtwork(tenantId);
    const form = makeForm({ name: "X", email: "x@test.com", message: "Hi" });

    const result = await submitInquiry(slug, artworkId, INITIAL_STATE, form);

    expect(result.status).toBe("error");
    const rows = await db.query.inquiriesTable.findMany({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(rows).toHaveLength(0);
  });

  it("artwork with showInGallery=false → returns error, no DB row", async () => {
    const { slug, tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId, false); // showInGallery=false
    const form = makeForm({ name: "X", email: "x@test.com", message: "Hi" });

    const result = await submitInquiry(slug, artworkId, INITIAL_STATE, form);

    expect(result.status).toBe("error");
    const rows = await db.query.inquiriesTable.findMany({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(rows).toHaveLength(0);
  });

  it("valid submission → artworkTitle and tenantId denormalized onto inquiry row", async () => {
    const { slug, tenantId } = await createTenant();
    const { artworkId } = await createArtwork(tenantId);
    const form = makeForm({ name: "Carol", email: "carol@test.com", message: "Love it!" });

    await submitInquiry(slug, artworkId, INITIAL_STATE, form);

    const row = await db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.artworkId, artworkId) });
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.artworkTitle).toMatch(/Inquiry Artwork/);
  });
});
