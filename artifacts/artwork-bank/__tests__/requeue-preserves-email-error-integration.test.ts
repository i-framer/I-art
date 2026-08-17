/**
 * requeueNoContactEmailInquiries — emailError preservation — unit-level integration.
 *
 * Calls requeueNoContactEmailInquiries(tenantId) directly on a real database
 * and asserts that emailError is still equal to NO_CONTACT_EMAIL_ERROR after
 * the call.  The sweep's candidate WHERE clause is `isNotNull(emailError)`, so
 * accidentally nulling emailError would silently drop requeued rows from every
 * future sweep run and break the retry loop.
 *
 * Assertions:
 *  1. emailError remains "no gallery contact email" (not null) after requeue.
 *  2. emailAttempts is reset to 0 so the row re-enters the sweep candidate set.
 *  3. emailLastAttemptAt is cleared so no backoff delay applies on the next run.
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
  return `${randomUUID()}-rpee-${RUN}-${++seq}`;
}

async function createTenant(businessName = "Preserve Email Error Test Gallery") {
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
    title: "Preserve Email Error Test Artwork",
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
    artworkTitle: "Preserve Email Error Test Artwork",
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
  "requeueNoContactEmailInquiries — emailError preservation — real-DB integration",
  () => {
    it(
      "leaves emailError equal to NO_CONTACT_EMAIL_ERROR after requeue so the sweep re-selects the row",
      async () => {
        // Arrange: one exhausted "no gallery contact email" inquiry.
        const { tenantId } = await createTenant();
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createExhaustedNoEmailInquiry(tenantId, artworkId);

        // Confirm the row starts in the exhausted state.
        const before = await inquiryRow(inquiryId);
        expect(before?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(before?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before?.emailLastAttemptAt).not.toBeNull();

        // Act: call requeue directly — this is what updateTenantSettings
        // invokes when a gallery adds a contact email after inquiries were
        // already exhausted.
        await requeueNoContactEmailInquiries(tenantId);

        // Assert — the row must still satisfy the sweep's WHERE clause:
        //   isNotNull(inquiriesTable.emailError)
        // A refactor that accidentally sets emailError = null here would cause
        // every requeued row to be silently dropped from all future sweep runs.
        const after = await inquiryRow(inquiryId);
        expect(after?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // The remaining fields must be reset so the sweep can re-deliver.
        expect(after?.emailAttempts).toBe(0);
        expect(after?.emailLastAttemptAt).toBeNull();
      },
    );
  },
);
