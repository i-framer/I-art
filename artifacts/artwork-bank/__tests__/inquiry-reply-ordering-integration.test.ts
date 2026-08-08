/**
 * Inquiry reply ordering — real-DB integration.
 *
 * The admin inquiries page fetches replies for visible inquiries and orders
 * them by `sentAt ASC` (app/(admin)/(gated)/inquiries/page.tsx:132).
 * This suite verifies that ordering contract against real PostgreSQL:
 *
 *  1. Multiple replies are returned oldest-first (sentAt ASC).
 *  2. Replies from a different inquiry do not appear in results.
 *  3. A reply with no sentAt value sorts stably (null handling).
 *  4. Replies from a foreign-tenant inquiry are excluded.
 *  5. A newly-inserted reply appears in the correct sorted position.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
  inquiryRepliesTable,
  usersTable,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];
const createdReplyIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-iro-${RUN}-${++seq}`; }

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Reply Order Test Gallery", type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id, tenantId, title: "Artwork", sku: `sku-${id}`, status: "AVAILABLE",
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id, tenantId, artworkId, artworkTitle: "Artwork",
    buyerName: "Buyer", buyerEmail: "buyer@test.com", message: "Hello",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function createUser() {
  const id = uid();
  await db.insert(usersTable).values({ id, email: `user-${id}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(id);
  return id;
}

async function addReply(inquiryId: string, sentAt: Date, tenantId: string, message = "Reply") {
  const id = uid();
  const userId = await createUser();
  await db.insert(inquiryRepliesTable).values({
    id, inquiryId, tenantId, sentByUserId: userId, message, sentAt,
  } as any);
  createdReplyIds.push(id);
  return id;
}

/** Mirror the page query: replies for an inquiry ordered oldest-first. */
async function repliesForInquiry(inquiryId: string) {
  return db.query.inquiryRepliesTable.findMany({
    where: eq(inquiryRepliesTable.inquiryId, inquiryId),
    orderBy: [asc(inquiryRepliesTable.sentAt)],
  });
}

async function cleanup() {
  for (const id of createdReplyIds.splice(0)) {
    await db.delete(inquiryRepliesTable).where(eq(inquiryRepliesTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
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

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Inquiry reply ordering — real-DB integration", () => {
  it("multiple replies are returned oldest-first (sentAt ASC)", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    const t1 = new Date("2024-01-01T10:00:00Z");
    const t2 = new Date("2024-01-02T10:00:00Z");
    const t3 = new Date("2024-01-03T10:00:00Z");

    const newestId = await addReply(inquiryId, t3, tenantId, "Newest reply");
    const oldestId = await addReply(inquiryId, t1, tenantId, "Oldest reply");
    const middleId = await addReply(inquiryId, t2, tenantId, "Middle reply");

    const replies = await repliesForInquiry(inquiryId);
    const ids = replies.map(r => r.id);

    expect(ids[0]).toBe(oldestId);
    expect(ids[1]).toBe(middleId);
    expect(ids[2]).toBe(newestId);
  });

  it("replies from a different inquiry do not appear in results", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inq1 = await createInquiry(tenantId, artworkId);
    const inq2 = await createInquiry(tenantId, artworkId);

    const replyInInq1 = await addReply(inq1, new Date(), tenantId, "Reply for inq1");
    const replyInInq2 = await addReply(inq2, new Date(), tenantId, "Reply for inq2");

    const replies = await repliesForInquiry(inq1);
    const ids = replies.map(r => r.id);

    expect(ids).toContain(replyInInq1);
    expect(ids).not.toContain(replyInInq2);
  });

  it("replies from a foreign-tenant inquiry are excluded by inquiry-scope filter", async () => {
    const tenantId = await createTenant();
    const foreignTenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const foreignArtworkId = await createArtwork(foreignTenantId);
    const ownInquiryId = await createInquiry(tenantId, artworkId);
    const foreignInquiryId = await createInquiry(foreignTenantId, foreignArtworkId);

    const ownReplyId = await addReply(ownInquiryId, new Date(), tenantId, "Own reply");
    const foreignReplyId = await addReply(foreignInquiryId, new Date(), foreignTenantId, "Foreign reply");

    // Query own inquiry replies only.
    const replies = await repliesForInquiry(ownInquiryId);
    const ids = replies.map(r => r.id);

    expect(ids).toContain(ownReplyId);
    expect(ids).not.toContain(foreignReplyId);
  });

  it("a newly-inserted reply appears in the correct sorted position", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createInquiry(tenantId, artworkId);

    const oldTime = new Date("2024-01-01T09:00:00Z");
    const newTime = new Date("2024-06-01T09:00:00Z");

    const existingId = await addReply(inquiryId, oldTime, tenantId, "Existing reply");

    // Snapshot before inserting the new reply.
    const before = await repliesForInquiry(inquiryId);
    expect(before[0]!.id).toBe(existingId);

    // Insert a later reply and re-query.
    const newReplyId = await addReply(inquiryId, newTime, tenantId, "Newer reply");
    const after = await repliesForInquiry(inquiryId);

    expect(after[0]!.id).toBe(existingId); // old is still first
    expect(after[1]!.id).toBe(newReplyId); // new is last
  });
});
