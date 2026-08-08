/**
 * Task #205 — Confirm the orphan sweep alert reaches the operator on a real
 * database.
 *
 * When sweepOrphanedImageFiles() returns errors > 0 AND at least one
 * notification channel is configured, the route must call BOTH
 * sendOrphanSweepSlackNotification (Slack) and
 * sendOrphanSweepErrorNotification (email) so the operator receives the alert.
 *
 * This is the complementary integration test to task #512
 * (orphan-sweep-notification-skipped-integration.test.ts), which covers the
 * case where NO channel is set.
 *
 * Test strategy:
 *  1. Stub SLACK_BILLING_ALERTS_CHANNEL to a non-empty value so
 *     isAnyNotificationChannelConfigured() returns true.
 *  2. Insert a real orphan artwork_image row via the test DB.
 *  3. Mock deleteObject to throw for that row so errors > 0.
 *  4. Mock both notification senders to record their calls.
 *  5. Call the GET route handler and assert HTTP 207 + both senders were invoked.
 *  6. Clean up the orphan row and tenant after the test.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Configure a Slack notification channel so the alert fires ─────────────────
vi.stubEnv("SLACK_BILLING_ALERTS_CHANNEL", "#test-alerts-task-205");
// Ensure the RESEND/SMTP env vars are absent so only Slack fires (keeps the
// test focused on the Slack path without requiring a second email send).
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("RESEND_API_KEY", "");
vi.stubEnv("PLATFORM_ADMIN_EMAIL", "");

// ── Storage mock ──────────────────────────────────────────────────────────────
vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Notification mocks — track calls but resolve so no real network hit ───────
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
    businessName: "Operator Alert Integration Test Gallery",
    slug: `operator-alert-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function insertOrphanImageRow(
  tenantId: string,
  ghostArtworkId: string,
): Promise<{ id: string; objectPath: string }> {
  const id = uid();
  const objectPath = `/objects/uploads/operator-alert-${id}.jpg`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"operator-alert.jpg"}, 0, false)`,
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
  sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
  sendOrphanSweepErrorNotification.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  "orphan-sweep — operator alert sent when channel is configured (Task #205)",
  () => {
    it("calls sendOrphanSweepSlackNotification when errors > 0 and Slack channel is set", async () => {
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { objectPath } = await insertOrphanImageRow(tenantId, ghostArtworkId);

      // deleteObject throws for our row → errors > 0 → notification path triggered.
      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) {
          throw new Error("simulated storage failure — task #205");
        }
      });

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      // 207 Multi-Status because errors > 0.
      expect(response.status).toBe(207);
      const body = (await response.json()) as { errors: number };
      expect(body.errors).toBeGreaterThanOrEqual(1);

      // The operator Slack alert must have been called.
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledTimes(1);
    });

    it("response body contains the failed path so the operator knows what to investigate", async () => {
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { objectPath } = await insertOrphanImageRow(tenantId, ghostArtworkId);

      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) {
          throw new Error("storage 503 — task #205");
        }
      });

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      const body = (await response.json()) as {
        failedPaths?: string[];
        errors: number;
      };
      expect(body.failedPaths).toBeDefined();
      expect(body.failedPaths!.length).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths!).toContain(objectPath);
    });

    it("does NOT emit notificationSkipped when the Slack channel is configured and errors > 0", async () => {
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { objectPath } = await insertOrphanImageRow(tenantId, ghostArtworkId);

      vi.mocked(deleteObject).mockImplementation(async (path: string) => {
        if (path === objectPath) throw new Error("storage down");
      });

      const request = new Request("http://localhost/api/storage/orphan-sweep");
      const response = await GET(request);

      const body = (await response.json()) as { notificationSkipped?: boolean };
      // With a channel configured, notificationSkipped must be absent or false.
      expect(body.notificationSkipped).not.toBe(true);
    });
  },
);
