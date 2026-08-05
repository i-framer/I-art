/**
 * Task #393 — Confirm the orphan sweep still returns 207 when Slack throws AND
 * email also throws on a real database.
 *
 * The unit test in orphan-sweep-alert.test.ts covers this scenario in
 * isolation (sweep mocked).  This integration test runs the real sweep against
 * a test database so a regression in the DB query path cannot hide behind the
 * mock.  Slack and email are both stubbed to throw; the response must still be
 * 207 with the correct sweep counts.
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

// ── Notification mocks — both channels throw ──────────────────────────────────

const sendOrphanSweepSlackNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("Slack network timeout")),
);
const sendOrphanSweepErrorNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("SMTP connection refused")),
);

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: any[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: any[]) =>
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
    businessName: "Sweep Dual-Notify Test Gallery",
    slug: `dual-notify-test-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/**
 * Insert an artwork_image row referencing a non-existent artwork, bypassing
 * the FK constraint so the row is a genuine orphan.
 */
async function insertOrphanImageRow(tenantId: string, ghostArtworkId: string) {
  const id = uid();
  const objectPath = `/objects/uploads/${id}`;

  await db.execute(sql`ALTER TABLE artwork_image DISABLE TRIGGER ALL`);
  try {
    await db.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"dual-notify-orphan.jpg"}, 0, false)`,
    );
  } finally {
    await db.execute(sql`ALTER TABLE artwork_image ENABLE TRIGGER ALL`);
  }

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
  vi.mocked(deleteObject).mockClear();
  // Clear call counts and reset the throwing behaviour for each test.
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepSlackNotification.mockRejectedValue(
    new Error("Slack network timeout"),
  );
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

  // Clean up orphan rows that may still be present (e.g. on test failure).
  for (const id of insertedOrphanImageIds) {
    await db
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.id, id))
      .catch(() => {});
  }
  // Cascade-delete tenants and their remaining child rows.
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "orphan-sweep route — dual notification failure on a real database (Task #393)",
  () => {
    it("returns 207 with correct sweep counts when Slack throws AND email also throws", async () => {
      // Arrange: insert a real orphan row so the sweep finds errors > 0 and
      // attempts to notify via both channels.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId, objectPath } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // Make deleteObject throw for this row so the sweep records an error and
      // triggers the notification path that exercises both channels.
      vi.mocked(deleteObject).mockRejectedValueOnce(
        new Error("simulated storage failure"),
      );

      // Act: run the real route (real DB query, stubbed notifications)
      const res = await GET(makeRequest());

      // Assert: 207 regardless of notification failures
      expect(res.status).toBe(207);

      // The body must carry the real sweep counts from the DB run.
      const body = res.body as unknown as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
      };
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      // The storage error means errors >= 1 and failedPaths includes our path.
      expect(body.errors).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths).toContain(objectPath);

      // Both notification functions must have been called (even though they threw).
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // The DB row is removed after the sweep regardless of storage/notify errors.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      // Remove from cleanup list — already gone.
      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("returns 207 with sweep body intact when Slack throws AND email throws across multiple orphan rows", async () => {
      // Arrange: two orphan rows so the sweep has a non-trivial result set.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const orphan1 = await insertOrphanImageRow(tenantId, ghostArtworkId);
      const orphan2 = await insertOrphanImageRow(tenantId, ghostArtworkId);

      // Both deleteObject calls fail so errors === 2 and failedPaths has both.
      vi.mocked(deleteObject).mockRejectedValue(
        new Error("simulated storage failure"),
      );

      // Act
      const res = await GET(makeRequest());

      // Assert: still 207
      expect(res.status).toBe(207);

      const body = res.body as unknown as {
        orphaned: number;
        errors: number;
        failedPaths: string[];
      };
      expect(body.orphaned).toBeGreaterThanOrEqual(2);
      expect(body.errors).toBeGreaterThanOrEqual(2);
      expect(body.failedPaths).toContain(orphan1.objectPath);
      expect(body.failedPaths).toContain(orphan2.objectPath);

      // Notifications attempted once each (per sweep run, not per row).
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // Restore mock so afterEach cleanup works correctly.
      vi.mocked(deleteObject).mockResolvedValue(undefined);

      // DB rows removed regardless.
      for (const { id } of [orphan1, orphan2]) {
        const rows = await db
          .select({ id: artworkImagesTable.id })
          .from(artworkImagesTable)
          .where(eq(artworkImagesTable.id, id));
        expect(rows).toHaveLength(0);

        const idx = insertedOrphanImageIds.indexOf(id);
        if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
      }
    });
  },
);
