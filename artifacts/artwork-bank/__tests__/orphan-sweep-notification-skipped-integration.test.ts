/**
 * Task #512 — Confirm the sweep 207 response flags notificationSkipped when
 * no channel is set on a real database.
 *
 * When the orphan sweep finishes with storage errors (errors > 0) AND neither
 * a Slack channel (SLACK_BILLING_ALERTS_CHANNEL) nor an email channel
 * (SMTP_HOST/RESEND_API_KEY + PLATFORM_ADMIN_EMAIL) is configured, the route
 * returns HTTP 207 with `notificationSkipped: true` in the body.
 *
 * This test:
 *  1. Stubs all notification-channel env vars to empty so
 *     isAnyNotificationChannelConfigured() returns false.
 *  2. Inserts a real orphan artwork_image row via the integration DB.
 *  3. Mocks deleteObject to throw (so errors > 0 triggers the notification path).
 *  4. Mocks both notification functions to resolve (they would also be no-ops
 *     with no channel configured, but mock-resolve guarantees neither sets a
 *     slackFailure/emailFailure string — so the notificationSkipped branch is hit).
 *  5. Calls the route handler directly and asserts HTTP 207 + notificationSkipped: true.
 *  6. Also confirms the DB orphan row is cleaned up despite the storage failure.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Stub notification-channel env vars to simulate an unconfigured operator ──
// vi.stubEnv must be called before the route module is imported so the check
// inside isAnyNotificationChannelConfigured() sees the stubbed values.
vi.stubEnv("SLACK_BILLING_ALERTS_CHANNEL", "");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("RESEND_API_KEY", "");
vi.stubEnv("PLATFORM_ADMIN_EMAIL", "");

// ── Mock storage so no real blob store is needed ──────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Mock notification functions — both resolve (no-op, no failure string) ─────
// This simulates what the real functions do when no channel is configured.
// Crucially, because they resolve (not throw), slackFailure and emailFailure
// stay undefined, and the isAnyNotificationChannelConfigured() check fires.
const sendOrphanSweepSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);
const sendOrphanSweepErrorNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: unknown[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: unknown[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

// ── Route and DB imports (after mocks) ───────────────────────────────────────
import { GET } from "@/app/api/storage/orphan-sweep/route";
import { db, artworkImagesTable, tenantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { deleteObject } from "@/lib/object-storage";

// ── DB helpers ────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

const createdTenantIds: string[] = [];
const insertedOrphanImageIds: string[] = [];

async function createTenant(): Promise<string> {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "Notify-Skipped Test Gallery",
    slug: `notify-skipped-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/**
 * Insert an orphan artwork_image row (FK bypass so the parent artwork is absent).
 */
async function insertOrphanImageRow(
  tenantId: string,
  ghostArtworkId: string,
): Promise<{ id: string; objectPath: string }> {
  const id = uid();
  const objectPath = `/objects/uploads/notify-skipped-${id}.jpg`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"notify-skipped.jpg"}, 0, false)`,
    );
  });

  insertedOrphanImageIds.push(id);
  return { id, objectPath };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  createdTenantIds.length = 0;
  insertedOrphanImageIds.length = 0;
  vi.mocked(deleteObject).mockReset();
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepErrorNotification.mockClear();
  // Both notification functions resolve by default (no channel, no-op).
  sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
  sendOrphanSweepErrorNotification.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  "orphan-sweep — 207 notificationSkipped when no channel configured (Task #512)",
  () => {
    it("returns 207 with notificationSkipped:true when errors>0 and no channel is set", async () => {
      // Arrange: real orphan row so the sweep encounters an error.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId, objectPath } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // deleteObject throws for our row → errors > 0 → notification path is entered.
      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) {
          throw new Error("simulated storage failure — task #512");
        }
      });

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      // Must be 207 Multi-Status because errors > 0.
      expect(response.status).toBe(207);

      const body = (await response.json()) as {
        orphaned: number;
        errors: number;
        failedPaths: string[];
        notificationSkipped?: boolean;
        notificationFailure?: unknown;
      };

      // Core sweep counts reflect the real DB work.
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths).toContain(objectPath);

      // The key assertion: notificationSkipped must be true because no channel
      // is configured and neither notification function threw.
      expect(body.notificationSkipped).toBe(true);

      // notificationFailure must NOT be set — it is only set when functions throw.
      expect(body.notificationFailure).toBeUndefined();

      // Both notification functions were still called (best-effort fire), but
      // because they resolved without error slackFailure/emailFailure stayed
      // undefined — leaving isAnyNotificationChannelConfigured() to catch this.
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // DB row cleaned up even though storage delete failed.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      // Already removed; skip afterEach cleanup for this row.
      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("does NOT set notificationSkipped when errors=0 (clean sweep)", async () => {
      // Arrange: deleteObject succeeds, no orphan row needed (or any existing
      // orphans from other tests will also be deleted cleanly).
      vi.mocked(deleteObject).mockResolvedValue(undefined);

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      // Errors = 0 → 200, no notification path entered at all.
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.notificationSkipped).toBeUndefined();
      expect(body.errors).toBe(0);

      // Notification functions must NOT be called when errors === 0.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });

    it("notificationSkipped:true appears with multiple simultaneous orphan storage failures", async () => {
      // Arrange: two real orphan rows so errors >= 2.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const orphan1 = await insertOrphanImageRow(tenantId, ghostArtworkId);
      const orphan2 = await insertOrphanImageRow(tenantId, ghostArtworkId);

      // Both storage deletions fail.
      vi.mocked(deleteObject).mockRejectedValue(
        new Error("simulated multi-row storage failure"),
      );

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      expect(response.status).toBe(207);
      const body = (await response.json()) as {
        orphaned: number;
        errors: number;
        failedPaths: string[];
        notificationSkipped?: boolean;
      };

      expect(body.orphaned).toBeGreaterThanOrEqual(2);
      expect(body.errors).toBeGreaterThanOrEqual(2);
      expect(body.failedPaths).toContain(orphan1.objectPath);
      expect(body.failedPaths).toContain(orphan2.objectPath);

      // notificationSkipped must still be true even with multiple errors.
      expect(body.notificationSkipped).toBe(true);

      // Restore mock so afterEach DB cleanup can remove the orphan rows.
      vi.mocked(deleteObject).mockResolvedValue(undefined);
    });
  },
);
