/**
 * Task #1004 — Confirm archived stuck inquiries don't inflate the admin error
 * banner (getEmailFailCount).
 *
 * Background:
 *   getEmailFailCount correctly excludes archived inquiries via
 *   isNull(archivedAt).  A "stuck exhausted" inquiry is one where:
 *     emailAttempts  = MAX_EMAIL_ATTEMPTS   (exhausted)
 *     emailClaimNonce IS NOT NULL           (crashed worker set the claim)
 *     emailLastAttemptAt IS NULL            (worker crashed before writing it)
 *
 *   Without the archivedAt filter, archiving a resolved lead would leave a
 *   phantom failure count in the admin banner.  This test confirms that once
 *   archivedAt is stamped the row falls out of the banner count.
 *
 * Flow under test:
 *  1. Seed a stuck exhausted inquiry (emailAttempts = MAX_EMAIL_ATTEMPTS,
 *     emailError set, emailClaimNonce IS NOT NULL, emailLastAttemptAt IS NULL).
 *  2. Assert getEmailFailCount ≥ 1  (stuck row IS visible — baseline).
 *  3. Archive the inquiry (set archivedAt to a non-null timestamp).
 *  4. Assert getEmailFailCount drops by exactly 1  (archived row is excluded).
 *
 * All assertions run against a real PostgreSQL database so the test catches
 * Drizzle query regressions, missing WHERE clauses, and column-mapping errors
 * that unit tests with a mocked DB cannot detect.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  userId: "u-1004-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1004",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
import { getEmailFailCount } from "@/app/(admin)/_actions/inquiry-count";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `t1004-${RUN}-${++seq}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Archived Banner Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1004@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1004",
    sku: `sku-1004-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const id of CREATED_INQUIRY_IDS.splice(0)) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of CREATED_ARTWORK_IDS.splice(0)) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of CREATED_TENANT_IDS.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});

afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "getEmailFailCount excludes archived stuck inquiries from the admin error banner — real DB (Task #1004)",
  () => {
    /**
     * Core assertion: archiving a stuck exhausted inquiry removes it from the
     * admin banner count (getEmailFailCount), confirming the isNull(archivedAt)
     * filter in the query is effective.
     */
    it(
      "archived stuck exhausted inquiry is excluded from getEmailFailCount (Task #1004)",
      { timeout: 30_000 },
      async () => {
        // ── Seed ─────────────────────────────────────────────────────────────

        const tenantId = makeId("tenant-1004");
        await insertTenant(tenantId);

        const artworkId = makeId("artwork-1004");
        await insertArtwork(artworkId, tenantId);

        const inqId = makeId("inq-1004");
        CREATED_INQUIRY_IDS.push(inqId);

        const transportErrorMsg =
          "Transport failure: 550 mailbox not found (1004)";

        // Insert with emailAttempts at the exhaustion limit, emailError set,
        // and emailLastAttemptAt = null (crashed worker never wrote it).
        await db.insert(inquiriesTable).values({
          id: inqId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork 1004",
          buyerName: "Archived Banner Buyer 1004",
          buyerEmail: "buyer-1004@example.com",
          message: "Is this still available?",
          emailError: transportErrorMsg,
          emailAttempts: MAX_EMAIL_ATTEMPTS,
          emailLastAttemptAt: null, // worker crashed before writing this
          status: "NEW",
        } as any);

        // Stamp a non-null nonce — simulates a worker that set the claim nonce
        // but crashed before writing emailLastAttemptAt.
        const crashedNonce = "crashed-nonce-1004";
        await db
          .update(inquiriesTable)
          .set({ emailClaimNonce: crashedNonce } as any)
          .where(eq(inquiriesTable.id, inqId));

        // Point the mocked session at this tenant so getEmailFailCount scopes
        // to the right tenant.
        mockSession.tenantId = tenantId;

        // ── Step 1: stuck row IS visible to admin (baseline) ──────────────────
        //
        // getEmailFailCount filters on:
        //   isNotNull(emailError) AND gte(emailAttempts, MAX_EMAIL_ATTEMPTS)
        //   AND isNull(archivedAt)
        //
        // The row satisfies all three conditions (archivedAt is still null),
        // so the admin banner must show it.

        const countBeforeArchive = await getEmailFailCount();
        expect(countBeforeArchive).toBeGreaterThanOrEqual(1);

        // ── Step 2: archive the inquiry ───────────────────────────────────────
        //
        // Simulate an admin resolving the lead by setting archivedAt to a
        // non-null timestamp.  The query's isNull(archivedAt) condition now
        // evaluates to false, so the row must drop out of the count.

        await db
          .update(inquiriesTable)
          .set({ archivedAt: new Date() } as any)
          .where(eq(inquiriesTable.id, inqId));

        // ── Step 3: archived row is excluded from the banner count ────────────
        //
        // getEmailFailCount must return exactly one fewer than before archiving,
        // confirming the isNull(archivedAt) filter is working correctly and
        // that archiving a stuck exhausted inquiry removes the phantom failure
        // from the admin banner.

        const countAfterArchive = await getEmailFailCount();
        expect(countAfterArchive).toBe(countBeforeArchive - 1);
      },
    );
  },
);
