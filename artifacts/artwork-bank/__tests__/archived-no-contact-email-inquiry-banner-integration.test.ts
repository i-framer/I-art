/**
 * Task #1008 — Confirm archiving a no-contact-email inquiry clears the admin
 * "no contact email" banner count.
 *
 * getNoContactEmailInquiryCount should include an active inquiry carrying the
 * NO_CONTACT_EMAIL_ERROR sentinel, but exclude it as soon as archivedAt is set.
 * This runs against PostgreSQL so regressions in the archivedAt predicate or
 * its Drizzle column mapping are caught by the integration suite.
 */
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, artworksTable, inquiriesTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const mockSession = {
  userId: "u-1008-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

import {
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";
import { getNoContactEmailInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

const RUN = randomUUID().slice(0, 8);
let sequence = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function makeId(label: string) {
  return `t1008-${RUN}-${++sequence}-${label}`;
}

async function insertTenant(id: string) {
  createdTenantIds.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Archived No Contact Email Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string) {
  createdArtworkIds.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1008",
    sku: `sku-1008-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertNoContactEmailInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
) {
  createdInquiryIds.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1008",
    buyerName: "No Contact Email Buyer 1008",
    buyerEmail: "buyer-1008@example.com",
    message: "Is this artwork still available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
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
  "Archiving a no-contact-email inquiry clears the admin banner — real DB (Task #1008)",
  () => {
    it(
      "excludes the archived inquiry from getNoContactEmailInquiryCount",
      { timeout: 30_000 },
      async () => {
        const tenantId = makeId("tenant");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork");
        await insertArtwork(artworkId, tenantId);

        const inquiryId = makeId("inquiry");
        await insertNoContactEmailInquiry(inquiryId, tenantId, artworkId);
        mockSession.tenantId = tenantId;

        const countBeforeArchive = await getNoContactEmailInquiryCount();
        expect(countBeforeArchive).toBeGreaterThanOrEqual(1);

        await db
          .update(inquiriesTable)
          .set({ archivedAt: new Date() })
          .where(eq(inquiriesTable.id, inquiryId));

        const countAfterArchive = await getNoContactEmailInquiryCount();
        expect(countAfterArchive).toBe(countBeforeArchive - 1);
      },
    );
  },
);