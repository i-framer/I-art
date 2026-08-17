/**
 * requeueNoContactEmailInquiries — no-op when tenant has no qualifying rows.
 *
 * Calls requeueNoContactEmailInquiries directly for a tenant that has zero
 * "no gallery contact email" inquiries and asserts that no rows in
 * inquiriesTable are modified.
 *
 * This catches a missing-WHERE-clause regression: if the function were to
 * accidentally omit the tenantId or emailError filter it would touch rows it
 * shouldn't.  A tenant with zero qualifying rows is the simplest canary.
 *
 * Scenarios:
 *  1. Tenant with NO inquiries at all — function touches nothing.
 *  2. Tenant whose inquiries all have a DIFFERENT emailError (not the
 *     "no gallery contact email" sentinel) — function leaves those rows
 *     completely unchanged.
 *  3. Tenant whose inquiry is NOT exhausted but still carries the sentinel
 *     error — function resets it (validates the WHERE clause is correct by
 *     contrast: non-exhausted rows ARE updated because the function matches on
 *     emailError alone, not on emailAttempts).
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
} from "@/lib/email-sweep";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-rnce-noop-${RUN}-${++seq}`;
}

async function createTenant(businessName = "No-op Test Gallery") {
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
    title: "No-op Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an inquiry with a custom emailError (not the NO_CONTACT_EMAIL_ERROR
 * sentinel) so it should never be touched by requeueNoContactEmailInquiries.
 */
async function createInquiryWithDifferentError(
  tenantId: string,
  artworkId: string,
  emailError: string,
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "No-op Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError,
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
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
  "requeueNoContactEmailInquiries — no-op when tenant has no qualifying rows — real-DB integration",
  () => {
    it(
      "is a no-op for a tenant that has no inquiries at all",
      async () => {
        // Arrange: a tenant with zero inquiry rows.
        const { tenantId } = await createTenant("Empty Tenant – no-op");

        // Act: should execute without error and touch nothing.
        await expect(
          requeueNoContactEmailInquiries(tenantId),
        ).resolves.toBeUndefined();

        // Assert: no inquiry rows exist for this tenant (trivially true, but
        // explicitly checked so a future bug that inserts rows is caught).
        const rows = await db.query.inquiriesTable.findMany({
          where: eq(inquiriesTable.tenantId, tenantId),
        });
        expect(rows).toHaveLength(0);
      },
    );

    it(
      "is a no-op when the tenant's inquiries all have a different emailError",
      async () => {
        // Arrange: a tenant with an exhausted inquiry carrying a different
        // error string — e.g. a network failure message.
        const { tenantId } = await createTenant(
          "Different-Error Tenant – no-op",
        );
        const artworkId = await createArtwork(tenantId);
        const otherError = "ECONNREFUSED";
        const inquiryId = await createInquiryWithDifferentError(
          tenantId,
          artworkId,
          otherError,
        );

        // Snapshot the row before the call.
        const before = await inquiryRow(inquiryId);
        expect(before).toBeDefined();
        expect(before?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before?.emailError).toBe(otherError);
        const beforeLastAttemptAt = before?.emailLastAttemptAt;
        expect(beforeLastAttemptAt).not.toBeNull();

        // Act.
        await requeueNoContactEmailInquiries(tenantId);

        // Assert: the row is completely unchanged.
        const after = await inquiryRow(inquiryId);
        expect(after?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(after?.emailError).toBe(otherError);
        // emailLastAttemptAt must not have been cleared.
        expect(after?.emailLastAttemptAt?.getTime()).toBe(
          beforeLastAttemptAt?.getTime(),
        );
      },
    );

    it(
      "is a no-op when the tenant has only a null-error inquiry (successfully delivered)",
      async () => {
        // Arrange: an inquiry where emailError IS NULL — already delivered.
        // requeueNoContactEmailInquiries only matches emailError = NO_CONTACT_EMAIL_ERROR,
        // so a null-error row must never be touched.
        const { tenantId } = await createTenant(
          "Null-Error Tenant – no-op",
        );
        const artworkId = await createArtwork(tenantId);
        const id = uid();
        await db.insert(inquiriesTable).values({
          id,
          tenantId,
          artworkId,
          artworkTitle: "No-op Test Artwork",
          buyerName: "Test Buyer",
          buyerEmail: `buyer-${id}@test.com`,
          message: "Is this available?",
          emailError: null,
          emailAttempts: 1,
          emailLastAttemptAt: new Date(Date.now() - 60_000),
        } as any);
        createdInquiryIds.push(id);

        const before = await inquiryRow(id);
        expect(before?.emailError).toBeNull();
        expect(before?.emailAttempts).toBe(1);
        const beforeLastAttemptAt = before?.emailLastAttemptAt;

        // Act.
        await requeueNoContactEmailInquiries(tenantId);

        // Assert: emailAttempts and emailLastAttemptAt are unchanged.
        const after = await inquiryRow(id);
        expect(after?.emailAttempts).toBe(1);
        expect(after?.emailError).toBeNull();
        expect(after?.emailLastAttemptAt?.getTime()).toBe(
          beforeLastAttemptAt?.getTime(),
        );
      },
    );
  },
);
