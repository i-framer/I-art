/**
 * requeueNoContactEmailInquiries — tenant isolation — unit-level integration.
 *
 * Calls requeueNoContactEmailInquiries(tenantAId) directly on a real database
 * that contains exhausted "no gallery contact email" inquiries for two
 * independent tenants. Asserts that only tenant A's inquiry is reset; tenant
 * B's row is left completely untouched.
 *
 * This catches a WHERE-clause regression instantly without needing the full
 * updateTenantSettings action stack.
 *
 *  1. Only the target tenant's exhausted no-contact-email inquiry is reset.
 *  2. Another tenant's exhausted no-contact-email inquiry is not touched.
 *  3. emailError is preserved (kept non-null) on the reset row so the sweep
 *     knows the row is a retry, not a fresh inquiry.
 *  4. emailLastAttemptAt is cleared on the reset row so no backoff delay
 *     applies to the next sweep run.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  requeueNoContactEmailInquiries,
  MAX_EMAIL_ATTEMPTS,
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-rnceti-${RUN}-${++seq}`;
}

async function createTenant(businessName = "Tenant Isolation Test Gallery") {
  const id = uid();
  const userId = uid();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName,
    type: "ARTIST",
    contactEmail: null,
  } as any);
  createdTenantIds.push(id);
  await db
    .insert(tenantUsersTable)
    .values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Tenant Isolation Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an exhausted inquiry whose emailError matches NO_CONTACT_EMAIL_ERROR,
 * mirroring what the sweep writes when it cannot find a gallery contact address.
 */
async function createExhaustedNoEmailInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Tenant Isolation Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({ where: eq(inquiriesTable.id, id) });
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, id))
      .catch(() => {});
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db
      .delete(usersTable)
      .where(eq(usersTable.id, id))
      .catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "requeueNoContactEmailInquiries — tenant isolation — real-DB integration",
  () => {
    it(
      "calling requeueNoContactEmailInquiries(tenantAId) resets only tenant A's exhausted inquiry, leaving tenant B's row untouched",
      async () => {
        // Arrange: two independent tenants, each with one exhausted
        // "no gallery contact email" inquiry.

        // --- Tenant A ---
        const { tenantId: tenantAId } = await createTenant("Gallery A – isolation");
        const artworkAId = await createArtwork(tenantAId);
        const inquiryAId = await createExhaustedNoEmailInquiry(tenantAId, artworkAId);

        // --- Tenant B ---
        const { tenantId: tenantBId } = await createTenant("Gallery B – isolation");
        const artworkBId = await createArtwork(tenantBId);
        const inquiryBId = await createExhaustedNoEmailInquiry(tenantBId, artworkBId);

        // Verify both inquiries start in the exhausted state.
        const beforeA = await inquiryRow(inquiryAId);
        const beforeB = await inquiryRow(inquiryBId);
        expect(beforeA?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(beforeB?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);

        // Act: call the function directly with only tenant A's id.
        await requeueNoContactEmailInquiries(tenantAId);

        // Assert — tenant A's inquiry must be reset.
        const afterA = await inquiryRow(inquiryAId);
        // emailAttempts reset to 0 so the row re-enters the sweep candidate set.
        expect(afterA?.emailAttempts).toBe(0);
        // emailError kept non-null so the sweep identifies this as a retry.
        expect(afterA?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        // emailLastAttemptAt cleared so no backoff delay applies.
        expect(afterA?.emailLastAttemptAt).toBeNull();

        // Assert — tenant B's inquiry must remain completely untouched.
        const afterB = await inquiryRow(inquiryBId);
        // emailAttempts must still be at the exhausted ceiling.
        expect(afterB?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        // emailError must be unchanged.
        expect(afterB?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        // emailLastAttemptAt must still be set (non-null) as inserted.
        expect(afterB?.emailLastAttemptAt).not.toBeNull();
      },
    );
  },
);
