/**
 * Task #1007 — Confirm archiving a stuck-nonce inquiry clears the admin
 * "stuck nonce" banner count.
 *
 * A stuck-nonce inquiry has emailClaimNonce IS NOT NULL and
 * emailLastAttemptAt IS NULL.  getStuckNonceCount should include that row
 * while it is active, but exclude it as soon as archivedAt is set.
 *
 * The assertions run against PostgreSQL so a regression in the archivedAt
 * predicate or its Drizzle column mapping is caught by the integration suite.
 */
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, artworksTable, inquiriesTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const mockSession = {
  userId: "u-1007-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

import { getStuckNonceCount } from "@/app/(admin)/_actions/inquiry-count";

const RUN = randomUUID().slice(0, 8);
let sequence = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function makeId(label: string) {
  return `t1007-${RUN}-${++sequence}-${label}`;
}

async function insertTenant(id: string) {
  createdTenantIds.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Archived Stuck Nonce Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1007@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string) {
  createdArtworkIds.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1007",
    sku: `sku-1007-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertStuckInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
) {
  createdInquiryIds.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1007",
    buyerName: "Stuck Nonce Buyer 1007",
    buyerEmail: "buyer-1007@example.com",
    message: "Is this artwork still available?",
    emailClaimNonce: randomUUID(),
    emailLastAttemptAt: null,
    archivedAt: null,
    status: "NEW",
  } as any);
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
  vi.clearAllMocks();
  await cleanup();
});

afterAll(cleanup);

describeIntegration(
  "Archiving a stuck-nonce inquiry clears the admin banner — real DB (Task #1007)",
  () => {
    it(
      "excludes an archived stuck-nonce inquiry from getStuckNonceCount",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        const inquiryId = makeId("inquiry");
        await insertStuckInquiry(inquiryId, tenantId, artworkId);
        mockSession.tenantId = tenantId;

        const countBeforeArchive = await getStuckNonceCount();
        expect(countBeforeArchive).toBeGreaterThanOrEqual(1);

        await db
          .update(inquiriesTable)
          .set({ archivedAt: new Date() } as any)
          .where(eq(inquiriesTable.id, inquiryId));

        const countAfterArchive = await getStuckNonceCount();
        expect(countAfterArchive).toBe(countBeforeArchive - 1);
      },
    );
  },
);