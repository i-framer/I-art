/**
 * submitInquiry (public storefront) — real-DB integration.
 *
 * No existing integration test covers the public inquiry submission action.
 * Unit tests in inquiry-rate-limit.test.ts and inquiry-actions test the
 * admin side.  This integration suite verifies public submission persistence
 * against real PostgreSQL:
 *
 *  1. Valid submission inserts an inquiry row with correct fields.
 *  2. Inquiry status defaults to NEW.
 *  3. Hidden artwork (showInGallery=false) returns error — no row inserted.
 *  4. Wrong artworkId (cross-tenant) returns error — no row inserted.
 *  5. Missing required fields (blank name) returns validation error.
 *  6. Honeypot field set → action returns sent without inserting a row.
 *  7. Email failure → Slack alert fires with correct tenant/buyer/artwork args.
 *  8. Email success → Slack alert is NOT called.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Rate limit — always pass through ─────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99 })),
  resetRateLimiter: vi.fn(async () => {}),
}));

// ── next/headers — needed for IP extraction ───────────────────────────────────
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

// ── Controlled sendArtworkInquiry mock — returns true by default (success).
// Individual tests can override to false to test the email-failure path.
const sendArtworkInquiry = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendArtworkInquiry,
    sendInquiryNotification: vi.fn(async () => {}),
    sendInquiryConfirmation: vi.fn(async () => {}),
  };
});

// ── Slack — spy on the inquiry email-failure alert. Returns ok:true by default.
const sendInquiryEmailFailureSlackNotification = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const })),
);
vi.mock("@/lib/slack", () => ({
  sendInquiryEmailFailureSlackNotification,
}));

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-subinq-${RUN}-${++seq}`; }

async function createTenant(contactEmail = "gallery@example.com") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Submit Inquiry Test Gallery",
    type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return { tenantId: id, slug: id };
}

async function createArtwork(tenantId: string, opts: { showInGallery?: boolean } = {}) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Test Artwork", sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: opts.showInGallery ?? true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  sendArtworkInquiry.mockReset();
  sendArtworkInquiry.mockResolvedValue(true);
  sendInquiryEmailFailureSlackNotification.mockReset();
  sendInquiryEmailFailureSlackNotification.mockResolvedValue({ ok: true });
  await cleanup();
});
afterAll(cleanup);

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("submitInquiry (public storefront) — real-DB integration", () => {
  it("valid submission inserts an inquiry row with correct fields and returns sent", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({
        name: "Jane Buyer",
        email: "jane@buyer.com",
        message: "Is this still available?",
        website: "", // honeypot blank
      }),
    );

    expect(result.status).toBe("sent");
    expect(result.error).toBe("");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    expect(row).toBeDefined();
    expect(row?.buyerName).toBe("Jane Buyer");
    expect(row?.buyerEmail).toBe("jane@buyer.com");
    expect(row?.message).toBe("Is this still available?");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.status).toBe("NEW");
    if (row?.id) createdInquiryIds.push(row.id);
  });

  it("hidden artwork (showInGallery=false) returns error — no row inserted", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId, { showInGallery: false });

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "Buyer", email: "b@b.com", message: "Hi", website: "" }),
    );

    expect(result.status).toBe("error");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    expect(row).toBeUndefined();
  });

  it("wrong artworkId (foreign artwork) returns error — no row inserted", async () => {
    const { slug } = await createTenant();
    const foreignArtworkId = randomUUID(); // does not exist

    const result = await submitInquiry(
      slug,
      foreignArtworkId,
      { status: "idle", error: "" },
      fd({ name: "Buyer", email: "b@b.com", message: "Hi", website: "" }),
    );

    expect(result.status).toBe("error");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, foreignArtworkId),
    });
    expect(row).toBeUndefined();
  });

  it("blank name returns validation error — no row inserted", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "", email: "b@b.com", message: "Hello", website: "" }),
    );

    expect(result.status).toBe("error");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    expect(row).toBeUndefined();
  });

  it("email delivery failure → inquiry still persisted; emailError field set; status=sent", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Simulate email failure by returning false.
    sendArtworkInquiry.mockResolvedValueOnce(false);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "Jane Buyer", email: "jane@buyer.com", message: "Available?", website: "" }),
    );

    // Lead must not be lost — action returns "sent" so the buyer isn't alarmed.
    expect(result.status).toBe("sent");
    expect(result.error).toBe("");

    // The inquiry row must be persisted with the delivery failure flag set.
    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    expect(row).toBeDefined();
    expect(row?.buyerEmail).toBe("jane@buyer.com");
    expect(row?.emailError).toBe("Email delivery failed");
  });

  it("honeypot field set → returns sent without inserting a row", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "Bot", email: "bot@spam.com", message: "Buy now", website: "https://spam.com" }),
    );

    expect(result.status).toBe("sent");

    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    expect(row).toBeUndefined();
  });

  it("email failure → Slack alert fires with correct tenant/buyer/artwork args", async () => {
    const { tenantId, slug } = await createTenant("gallery@example.com");
    const artworkId = await createArtwork(tenantId);

    // Force email delivery to fail.
    sendArtworkInquiry.mockResolvedValueOnce(false);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "Alice Collector", email: "alice@collector.com", message: "Is it available?", website: "" }),
    );

    // Submission should still return "sent" so the buyer is not alarmed.
    expect(result.status).toBe("sent");

    // Allow the fire-and-forget Slack promise to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The Slack alert must have been called exactly once with correct args.
    expect(sendInquiryEmailFailureSlackNotification).toHaveBeenCalledTimes(1);
    expect(sendInquiryEmailFailureSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantName: "Submit Inquiry Test Gallery",
        tenantSlug: slug,
        buyerName: "Alice Collector",
        buyerEmail: "alice@collector.com",
        artworkTitle: "Test Artwork",
        // inquiryId is the real DB-assigned UUID — just verify it is a non-empty string.
        inquiryId: expect.any(String),
      }),
    );

    // Clean up the persisted inquiry row.
    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    if (row?.id) createdInquiryIds.push(row.id);
  });

  it("email success → Slack alert is NOT called", async () => {
    const { tenantId, slug } = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Email succeeds (default mock behaviour).
    sendArtworkInquiry.mockResolvedValueOnce(true);

    const result = await submitInquiry(
      slug,
      artworkId,
      { status: "idle", error: "" },
      fd({ name: "Bob Buyer", email: "bob@buyer.com", message: "Interested!", website: "" }),
    );

    expect(result.status).toBe("sent");

    // Allow any fire-and-forget promises to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // When email succeeds the Slack alert must not fire.
    expect(sendInquiryEmailFailureSlackNotification).not.toHaveBeenCalled();

    // Clean up the persisted inquiry row.
    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.artworkId, artworkId),
    });
    if (row?.id) createdInquiryIds.push(row.id);
  });
});
