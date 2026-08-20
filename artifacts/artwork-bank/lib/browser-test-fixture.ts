import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  artworksTable,
  db,
  inquiriesTable,
  tenantsTable,
  tenantUsersTable,
  usersTable,
} from "@workspace/db";
import { hashPassword } from "@/lib/auth";

const TEST_MODE_VALUE = "enabled";
const FIXTURE_PREFIX = "browser-test-";

function hasExplicitBrowserTestDatabase(): boolean {
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  const browserTestDatabaseUrl = process.env.BROWSER_TEST_DATABASE_URL;
  return Boolean(
    runtimeDatabaseUrl &&
      browserTestDatabaseUrl &&
      runtimeDatabaseUrl === browserTestDatabaseUrl,
  );
}

export type BrowserTestFixture = {
  runId: string;
  tenantId: string;
  userId: string;
  email: string;
};

export function isBrowserTestFixtureIdentity(
  fixture: Pick<BrowserTestFixture, "runId" | "tenantId" | "userId">,
): boolean {
  return Boolean(fixture.runId) &&
    fixture.tenantId === `${FIXTURE_PREFIX}tenant-${fixture.runId}` &&
    fixture.userId === `${FIXTURE_PREFIX}user-${fixture.runId}`;
}

/**
 * Browser-test access is deliberately an explicit opt-in. It must never be
 * available in a production build, even if the flag were configured there.
 */
export function isBrowserTestModeEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.BROWSER_TEST_MODE === TEST_MODE_VALUE &&
    hasExplicitBrowserTestDatabase()
  );
}

function requireBrowserTestMode() {
  if (!isBrowserTestModeEnabled()) {
    throw new Error(
      "Browser test mode requires an explicit matching BROWSER_TEST_DATABASE_URL.",
    );
  }
}

/**
 * Creates a logically isolated gallery and the two inquiries used by the
 * browser test. These are inserted directly so no buyer, gallery, Slack, or
 * payment notification is triggered.
 */
export async function createBrowserTestFixture(): Promise<BrowserTestFixture> {
  requireBrowserTestMode();

  const runId = randomUUID();
  const tenantId = `${FIXTURE_PREFIX}tenant-${runId}`;
  const userId = `${FIXTURE_PREFIX}user-${runId}`;
  const artworkId = `${FIXTURE_PREFIX}artwork-${runId}`;
  const survivingInquiryId = `${FIXTURE_PREFIX}survives-${runId}`;
  const staleInquiryId = `${FIXTURE_PREFIX}stale-${runId}`;
  const email = `${FIXTURE_PREFIX}${runId}@example.test`;
  const suffix = runId.slice(0, 8);
  // Hash outside the transaction because bcrypt is CPU-bound; this keeps the
  // short-lived fixture transaction focused on database writes.
  const passwordHash = await hashPassword(randomUUID());

  await db.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: tenantId,
      slug: `${FIXTURE_PREFIX}${runId}`,
      businessName: `Browser Test Gallery ${suffix}`,
      type: "ARTIST",
      billingExempt: true,
    });

    await tx.insert(usersTable).values({
      id: userId,
      email,
      // This never leaves the server or appears in the test UI. It exists only
      // to satisfy the normal app_user schema while session auth is exercised.
      passwordHash,
    });

    await tx.insert(tenantUsersTable).values({
      tenantId,
      userId,
      role: "owner",
    });

    await tx.insert(artworksTable).values({
      id: artworkId,
      tenantId,
      title: `Browser Test Artwork ${suffix}`,
      sku: `${FIXTURE_PREFIX}${runId}`,
      status: "AVAILABLE",
      showInGallery: true,
    });

    await tx.insert(inquiriesTable).values([
      {
        id: survivingInquiryId,
        tenantId,
        artworkId,
        artworkTitle: `Browser Test Artwork ${suffix}`,
        buyerName: `Browser test inquiry to keep ${suffix}`,
        buyerEmail: `keep-${runId}@example.test`,
        message: "This inquiry should be marked as handled by the browser test.",
        status: "NEW",
      },
      {
        id: staleInquiryId,
        tenantId,
        artworkId,
        artworkTitle: `Browser Test Artwork ${suffix}`,
        buyerName: `Browser test stale inquiry ${suffix}`,
        buyerEmail: `stale-${runId}@example.test`,
        message: "This inquiry is deleted after selection to verify partial success.",
        status: "NEW",
      },
    ]);
  });

  return { runId, tenantId, userId, email };
}

/**
 * Deletes only the rows identified by a signed browser-test session. The
 * explicit ID prefix prevents this helper from being used on ordinary tenants.
 */
export async function cleanupBrowserTestFixture(
  fixture: Pick<BrowserTestFixture, "runId" | "tenantId" | "userId">,
): Promise<void> {
  requireBrowserTestMode();

  if (!isBrowserTestFixtureIdentity(fixture)) {
    throw new Error("Refusing to clean up a non-browser-test fixture.");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.tenantId, fixture.tenantId));
    await tx
      .delete(artworksTable)
      .where(eq(artworksTable.tenantId, fixture.tenantId));
    await tx
      .delete(tenantUsersTable)
      .where(
        and(
          eq(tenantUsersTable.tenantId, fixture.tenantId),
          eq(tenantUsersTable.userId, fixture.userId),
        ),
      );
    await tx.delete(usersTable).where(eq(usersTable.id, fixture.userId));
    await tx.delete(tenantsTable).where(eq(tenantsTable.id, fixture.tenantId));
  });
}