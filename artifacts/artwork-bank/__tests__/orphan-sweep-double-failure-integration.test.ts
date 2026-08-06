/**
 * Task #402 — Confirm the sweep correctly handles the case where both the
 * storage delete and the DB row removal fail for the same orphan.
 *
 * The sweep deletes the DB row in a try/catch block that runs regardless of
 * whether storage deletion succeeded or failed (lib/orphan-image-sweep.ts,
 * the finally-style block around line 117).  This test confirms that when
 * storage throws a real (non-404) error AND the subsequent DB delete also
 * throws:
 *
 *   - errors is incremented exactly once (for the storage failure).
 *     The sweep must NOT double-count by incrementing errors a second time
 *     for the DB row removal failure.  The code comment "Don't increment
 *     errors again" is the explicit contract.
 *
 *   - failedPaths contains the orphan's objectPath so operators can
 *     investigate.
 *
 *   - The row still exists in the DB after the sweep, because both operations
 *     failed.  The next sweep run will find it, attempt the storage deletion
 *     again (which will 404 and be treated as success), and then remove the
 *     row cleanly.
 *
 * The sweep function (sweepOrphanedImageFiles) is called directly — no HTTP
 * layer — so this test exercises only the core logic in
 * lib/orphan-image-sweep.ts without any routing or Next.js overhead.
 *
 * Strategy for forcing the DB delete to fail
 * -------------------------------------------
 * vi.spyOn(db, 'delete') is unreliable for drizzle clients because the
 * `delete` method may sit on the prototype and may not be enumerable/writable.
 * Instead we vi.mock('@workspace/db') with importActual so every caller in
 * this test process (including the sweep) sees a Proxy db.  The Proxy
 * delegates to the real db for every method EXCEPT `delete` when the shared
 * `dbState.throwOnDelete` flag is true.  We set the flag just before calling
 * the sweep and reset it in afterEach before cleanup runs.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Shared flag that the @workspace/db mock reads ─────────────────────────────

/** Mutated by the test to toggle whether db.delete should throw. */
const dbState = { throwOnDelete: false };

// ── Mock @workspace/db — wrap the real db in a Proxy ─────────────────────────
// importActual gives us the real module.  We re-export everything unchanged
// except db, which is wrapped in a Proxy that intercepts `delete` while
// dbState.throwOnDelete is true.  The Proxy is in place for the whole test
// file, so we control behaviour only through the flag.

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const realDb = actual.db;

  const dbProxy = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "delete" && dbState.throwOnDelete) {
        // Return a fake delete-builder whose .where() always rejects.
        return function _blockedDelete() {
          return {
            where() {
              return Promise.reject(
                new Error("simulated DB failure: connection closed"),
              );
            },
          };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { ...actual, db: dbProxy };
});

// ── Mock storage so no real blob store is needed ──────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Sweep and DB imports (after mocks are in place) ───────────────────────────

import { sweepOrphanedImageFiles } from "@/lib/orphan-image-sweep";
import { db, artworkImagesTable, tenantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { deleteObject } from "@/lib/object-storage";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    businessName: "Sweep Double-Failure Test Gallery",
    slug: `double-failure-test-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/**
 * Insert an artwork_image row referencing a non-existent artwork, bypassing
 * the FK constraint so the row is a genuine orphan.
 *
 * SET LOCAL session_replication_role = 'replica' disables FK trigger firing
 * for the duration of this transaction.  SET LOCAL is transaction-scoped: the
 * setting reverts on commit/rollback, so no other concurrent session observes
 * the replication-role change.
 */
async function insertOrphanImageRow(
  tenantId: string,
  ghostArtworkId: string,
): Promise<{ id: string; objectPath: string }> {
  const id = uid();
  const objectPath = `/objects/uploads/${id}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"double-failure-orphan.jpg"}, 0, false)`,
    );
  });

  insertedOrphanImageIds.push(id);
  return { id, objectPath };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  createdTenantIds.length = 0;
  insertedOrphanImageIds.length = 0;
  dbState.throwOnDelete = false;
  // mockReset clears call tracking AND the once-implementation queue so a
  // once-rejection from a failing test cannot leak into the next test.
  vi.mocked(deleteObject).mockReset();
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  // Reset the DB-delete flag BEFORE cleanup so the proxy forwards real deletes.
  dbState.throwOnDelete = false;
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
  "orphan-sweep — double failure: storage error AND DB row removal fails (Task #402)",
  () => {
    it(
      "records errors === 1 (not 2) and leaves the row in the DB when " +
        "storage delete throws AND the DB row removal also throws",
      async () => {
        // Arrange: insert a real orphan row into the integration DB.
        const tenantId = await createTenant();
        const ghostArtworkId = uid();
        const { id: orphanId, objectPath } = await insertOrphanImageRow(
          tenantId,
          ghostArtworkId,
        );

        // Storage delete throws a real (non-404) error for this specific path.
        // Path-keyed: always applies to our row regardless of other orphan rows
        // that may already be in the DB from other test files.
        vi.mocked(deleteObject).mockImplementation(async (path: string) => {
          if (path === objectPath) {
            throw new Error("simulated storage failure: ECONNRESET");
          }
          // Other paths resolve normally so unrelated orphan rows don't
          // contribute to errors and skew the assertion.
        });

        // Enable the DB proxy so db.delete() throws inside the sweep.
        // This is reset to false in afterEach before cleanup runs.
        dbState.throwOnDelete = true;

        // Act: call the sweep function directly (no HTTP layer needed).
        const result = await sweepOrphanedImageFiles();

        // Reset the flag immediately after the sweep so the db.select below
        // can use the real db path (db.select is unaffected by the flag, but
        // reset here for clarity).
        dbState.throwOnDelete = false;

        // ── Assert: sweep counts ──────────────────────────────────────────────

        // errors must be exactly 1.  The storage failure increments it once;
        // the DB row removal failure must NOT increment it a second time.
        // The contract is documented in orphan-image-sweep.ts:
        //   "Don't increment errors again — this is the DB row, not the
        //    storage file."
        expect(result.errors).toBe(1);

        // The failed objectPath is recorded so operators can investigate.
        expect(result.failedPaths).toContain(objectPath);

        // At minimum our one orphan was identified.
        expect(result.orphaned).toBeGreaterThanOrEqual(1);

        // ── Assert: row still in DB ───────────────────────────────────────────

        // The row must still exist: the storage delete failed, then the DB
        // delete also failed, so nothing was removed.  The next sweep run
        // will retry the storage deletion (which will 404 → treated as
        // success) and then remove the row cleanly.
        const remaining = await db
          .select({ id: artworkImagesTable.id })
          .from(artworkImagesTable)
          .where(eq(artworkImagesTable.id, orphanId));

        expect(remaining).toHaveLength(1);

        // Leave orphanId in insertedOrphanImageIds so afterEach (with
        // throwOnDelete=false) can delete it during cleanup.
      },
    );
  },
);
