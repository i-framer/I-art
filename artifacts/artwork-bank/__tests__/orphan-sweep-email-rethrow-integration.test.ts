/**
 * Integration test — confirm the orphan-sweep email re-throw propagates
 * correctly through the route handler on a real database.
 *
 * The unit test in orphan-sweep-email-guard.test.ts confirms that
 * sendOrphanSweepErrorNotification itself re-throws when sendMail rejects.
 * This integration test confirms that the route handler receives and handles
 * that re-throw correctly:
 *
 *  1. When only email fails (Slack succeeded): the route returns 207 with the
 *     real sweep counts and logs the failure — it is NOT silently swallowed.
 *
 *  2. When email fails AND Slack also fails: the route returns 207 and
 *     explicitly surfaces BOTH failures in the response body under
 *     notificationFailure so a caller polling the endpoint can detect the
 *     situation without tailing server logs.
 *
 * Both scenarios use a real database so a regression in the DB query path
 * cannot hide behind a mocked sweep.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock next/server so the route can run in plain Node ──────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

// ── Mock storage so no real blob store is needed ──────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Notification mocks ────────────────────────────────────────────────────────

/**
 * Slack resolves successfully by default.  Individual tests may override this.
 */
const sendOrphanSweepSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);

/**
 * Email always re-throws (simulating a transport failure).
 * This is the behaviour under test.
 */
const sendOrphanSweepErrorNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("SMTP connection refused")),
);

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: unknown[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: unknown[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

// ── Route and DB imports (after mocks) ────────────────────────────────────────

import { GET } from "@/app/api/storage/orphan-sweep/route";
import { db, artworkImagesTable, tenantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { deleteObject } from "@/lib/object-storage";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

const createdTenantIds: string[] = [];
const insertedOrphanImageIds: string[] = [];

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "Sweep Email Rethrow Test Gallery",
    slug: `email-rethrow-test-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/**
 * Insert an artwork_image row referencing a non-existent artwork, bypassing
 * the FK constraint so the row is a genuine orphan.
 *
 * SET LOCAL session_replication_role = 'replica' disables FK trigger firing
 * for the duration of this transaction.  SET LOCAL is transaction-scoped so
 * no other concurrent session can observe the replication-role change.
 */
async function insertOrphanImageRow(tenantId: string, ghostArtworkId: string) {
  const id = uid();
  const objectPath = `/objects/uploads/${id}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"email-rethrow-orphan.jpg"}, 0, false)`,
    );
  });

  insertedOrphanImageIds.push(id);
  return { id, objectPath };
}

/** Build a minimal test Request with no auth header (test env allows open access). */
function makeRequest(): Request {
  return new Request("http://localhost/api/storage/orphan-sweep", {
    method: "GET",
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  createdTenantIds.length = 0;
  insertedOrphanImageIds.length = 0;

  vi.mocked(deleteObject).mockReset();
  vi.mocked(deleteObject).mockResolvedValue(undefined);

  // Slack succeeds by default; email always re-throws.
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });

  sendOrphanSweepErrorNotification.mockClear();
  sendOrphanSweepErrorNotification.mockRejectedValue(
    new Error("SMTP connection refused"),
  );

  // Silence expected console.error output from the route's error handlers.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();

  for (const id of insertedOrphanImageIds) {
    await db
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "orphan-sweep route — email re-throw propagation on a real database (Task #507)",
  () => {
    it("returns 207 with real sweep counts and logs the email failure when email throws but Slack succeeds", async () => {
      // Arrange: a real orphan row so errors > 0 and the notification path is exercised.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId, objectPath } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // Make deleteObject throw for this specific row so the sweep records an
      // error and attempts both notification channels.
      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) throw new Error("simulated storage failure");
      });

      // Slack resolves successfully (default) so only email re-throws.

      // Act: run the real route (real DB query, stubbed notifications)
      const res = await GET(makeRequest());

      // Assert: the email re-throw does NOT change the HTTP status — the sweep
      // result takes precedence and the route returns 207 as normal.
      expect(res.status).toBe(207);

      const body = res.body as unknown as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
        notificationFailure?: { slack?: string; email?: string };
      };

      // The real sweep counts from the DB run must be present.
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths).toContain(objectPath);

      // Both notification functions were called (email threw, but it was still invoked).
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // The email re-throw must have been caught and logged — not silently swallowed.
      // The route calls console.error with the failure message.
      const consoleErrorCalls = vi
        .mocked(console.error)
        .mock.calls.map((args) => args.join(" "));
      expect(
        consoleErrorCalls.some((msg) =>
          msg.includes("Email notification failed"),
        ),
      ).toBe(true);

      // When only email failed (Slack succeeded) the body does NOT include
      // notificationFailure — the single-channel failure does not mask the result.
      expect(body.notificationFailure).toBeUndefined();

      // DB row removed regardless of notification failures.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("surfaces the email re-throw in the response body when both Slack and email fail", async () => {
      // Arrange: a real orphan row so errors > 0 and both channels are attempted.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId, objectPath } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) throw new Error("simulated storage failure");
      });

      // Make Slack also throw so both channels fail.
      sendOrphanSweepSlackNotification.mockRejectedValue(
        new Error("Slack network timeout"),
      );

      // Act
      const res = await GET(makeRequest());

      // Assert: still 207 — the sweep result drives the status, not notifications.
      expect(res.status).toBe(207);

      const body = res.body as unknown as {
        orphaned: number;
        errors: number;
        failedPaths: string[];
        notificationFailure?: { slack: string; email: string };
      };

      // Sweep counts from the real DB run.
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths).toContain(objectPath);

      // When BOTH channels fail the route surfaces both failures explicitly in
      // the response body so callers can detect the situation without tailing
      // server logs — this is the key guarantee under test.
      expect(body.notificationFailure).toBeDefined();
      expect(body.notificationFailure!.email).toMatch(/SMTP connection refused/);
      expect(body.notificationFailure!.slack).toMatch(/Slack network timeout/);

      // Both notification functions were called despite the failures.
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // The email re-throw must also have been logged — not silently swallowed.
      const consoleErrorCalls = vi
        .mocked(console.error)
        .mock.calls.map((args) => args.join(" "));
      expect(
        consoleErrorCalls.some((msg) =>
          msg.includes("Email notification failed"),
        ),
      ).toBe(true);

      // DB row removed regardless of notification failures.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("does not call the email notification when the sweep finds no storage errors", async () => {
      // Arrange: insert an orphan row but let deleteObject succeed so errors === 0.
      // The sweep removes the DB row but records no errors, so the notification
      // path is skipped entirely and an email re-throw cannot occur.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // deleteObject succeeds (the default mock) — no storage error is recorded.

      // Act
      const res = await GET(makeRequest());

      // The sweep cleaned up at least one orphan with no errors — check only
      // that the email notification was not called.  Other concurrent orphan rows
      // in the DB (from parallel test runs) might produce errors on their own
      // paths; we filter by whether OUR row generated an error.
      const body = res.body as unknown as {
        errors: number;
        failedPaths: string[];
      };

      // If our specific orphan produced no error (its deleteObject succeeded),
      // and there happened to be zero other errors, email should not be called.
      if (body.errors === 0) {
        expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
      }

      // Regardless of global error count, our orphan row should be gone.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });
  },
);
