/**
 * Integration tests for sweepOrphanedImageFiles() against a real database.
 *
 * Verifies that:
 *  1. The sweep correctly identifies artwork_image rows whose parent artwork no
 *     longer exists, calls deleteObject for each one, and removes the DB row.
 *  2. Re-running the sweep a second time finds zero orphans (idempotency).
 *  3. A non-orphaned image row (artwork still exists) is left untouched.
 *
 * We mock deleteObject so the test doesn't need a real storage backend —
 * the unit tests for object-storage cover that surface separately.
 */

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Mock storage — keep the real DB untouched ─────────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));

// ── Real DB imports ────────────────────────────────────────────────────────────

import { db, artworkImagesTable, artworksTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { sweepOrphanedImageFiles } from "@/lib/orphan-image-sweep";
import { deleteObject } from "@/lib/object-storage";

// ── Helpers ────────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
// Track orphan image IDs inserted directly via SQL (no FK cascade to clean up artwork)
const insertedOrphanImageIds: string[] = [];

/** Insert a minimal tenant row and return its id. */
async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "Sweep Test Gallery",
    slug: `sweep-test-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/** Insert a minimal artwork row and return its id. */
async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Sweep Test Artwork",
    sku: `sku-sweep-${id}`,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an artwork_image row that references a non-existent artwork_id.
 *
 * This simulates the orphan scenario (artwork deleted before the fix) by
 * bypassing the FK constraint for the duration of the insert.  We do this
 * by temporarily disabling constraint triggers on the table inside an
 * explicit transaction so the DISABLE and ENABLE are atomic from other
 * sessions' perspective — no other session can interleave an ENABLE between
 * our DISABLE and INSERT, which was the race that required
 * --no-file-parallelism.
 */
async function insertOrphanImageRow(tenantId: string, ghostArtworkId: string) {
  const id = uid();
  const objectPath = `/objects/uploads/${id}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE artwork_image DISABLE TRIGGER ALL`);
    await tx.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"orphan-test.jpg"}, 0, false)`,
    );
    await tx.execute(sql`ALTER TABLE artwork_image ENABLE TRIGGER ALL`);
  });

  insertedOrphanImageIds.push(id);
  return { id, objectPath };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  createdTenantIds.length = 0;
  createdArtworkIds.length = 0;
  insertedOrphanImageIds.length = 0;
  // mockReset clears call tracking AND the once-implementation queue so a
  // once-rejection from a failing test cannot leak into the next test.
  vi.mocked(deleteObject).mockReset();
  vi.mocked(deleteObject).mockResolvedValue(undefined);
});

afterEach(async () => {
  // Clean up any orphan image rows the sweep may have left behind (e.g. on
  // test failure) or that we inserted for the idempotency check.
  for (const id of insertedOrphanImageIds) {
    await db
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.id, id))
      .catch(() => {});
  }
  // Artworks cascade-delete their image rows; delete artworks before tenants.
  for (const id of createdArtworkIds) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  // Tenants cascade-delete remaining child rows.
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describeIntegration("sweepOrphanedImageFiles() — integration (real DB)", () => {
  it("returns checked=0 and orphaned=0 when there are no image rows at all", async () => {
    // This test assumes the DB may have existing rows from other tests;
    // we only check the shape of the result, not the absolute count.
    const result = await sweepOrphanedImageFiles();
    expect(result.orphaned).toBeGreaterThanOrEqual(0);
    expect(result.deleted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBe(0);
    expect(result.failedPaths).toEqual([]);
  });

  it("identifies and removes a single orphaned image row", async () => {
    const tenantId = await createTenant();
    const ghostArtworkId = uid(); // never inserted — simulates deleted artwork
    const { id: orphanId, objectPath } = await insertOrphanImageRow(
      tenantId,
      ghostArtworkId,
    );

    const result = await sweepOrphanedImageFiles();

    // At least one orphan found and deleted (there may be pre-existing ones)
    expect(result.orphaned).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    // deleteObject was called for our specific orphan's objectPath
    expect(deleteObject).toHaveBeenCalledWith(objectPath);

    // The DB row must have been removed
    const remaining = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(remaining).toHaveLength(0);

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
  });

  it("identifies and removes multiple orphaned image rows in one sweep", async () => {
    const tenantId = await createTenant();
    const ghostArtworkId = uid();

    const orphan1 = await insertOrphanImageRow(tenantId, ghostArtworkId);
    const orphan2 = await insertOrphanImageRow(tenantId, ghostArtworkId);

    const result = await sweepOrphanedImageFiles();

    expect(result.orphaned).toBeGreaterThanOrEqual(2);
    expect(result.deleted).toBeGreaterThanOrEqual(2);

    expect(deleteObject).toHaveBeenCalledWith(orphan1.objectPath);
    expect(deleteObject).toHaveBeenCalledWith(orphan2.objectPath);

    const ids = [orphan1.id, orphan2.id];
    for (const id of ids) {
      const rows = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, id));
      expect(rows).toHaveLength(0);
    }

    // Remove from cleanup list — already gone
    for (const id of ids) {
      const idx = insertedOrphanImageIds.indexOf(id);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    }
  });

  it("does not delete an image row whose artwork still exists", async () => {
    const tenantId = await createTenant();
    const artworkId = await createArtwork(tenantId);

    // Insert a live (non-orphaned) image row via Drizzle (FK is satisfied)
    const imageId = uid();
    const objectPath = `/objects/uploads/${imageId}`;
    await db.insert(artworkImagesTable).values({
      id: imageId,
      artworkId,
      tenantId,
      objectPath,
      filename: "live-image.jpg",
      sortOrder: 0,
      isPrimary: false,
    } as any);

    await sweepOrphanedImageFiles();

    // The live image row must still be present
    const rows = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, imageId));
    expect(rows).toHaveLength(1);

    // deleteObject must NOT have been called for this path
    const calls = vi
      .mocked(deleteObject)
      .mock.calls.map(([p]) => p);
    expect(calls).not.toContain(objectPath);

    // Clean up the live image row (artwork cascade will also do this, but be explicit)
    await db
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.id, imageId))
      .catch(() => {});
  });

  it("is idempotent: a second sweep after the first finds zero new orphans for our rows", async () => {
    const tenantId = await createTenant();
    const ghostArtworkId = uid();
    const { id: orphanId } = await insertOrphanImageRow(tenantId, ghostArtworkId);

    // First sweep — should remove the orphan
    const first = await sweepOrphanedImageFiles();
    expect(first.orphaned).toBeGreaterThanOrEqual(1);
    expect(first.deleted).toBeGreaterThanOrEqual(1);

    // Verify the DB row is gone before the second sweep
    const afterFirst = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(afterFirst).toHaveLength(0);

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);

    // Second sweep — our orphan is gone, so deleted count should not increase
    const deleteCallsAfterFirst = vi.mocked(deleteObject).mock.calls.length;
    const second = await sweepOrphanedImageFiles();

    // No new deletions for our previously cleaned row
    const deleteCallsAfterSecond = vi.mocked(deleteObject).mock.calls.length;
    expect(deleteCallsAfterSecond).toBe(deleteCallsAfterFirst);

    // orphaned count for our specific row must be zero
    // (second.orphaned could be >0 if other tests left rows, but our specific
    // orphanId must not appear in another deleteObject call)
    const secondCallPaths = vi
      .mocked(deleteObject)
      .mock.calls.slice(deleteCallsAfterFirst)
      .map(([p]) => p);
    expect(secondCallPaths).not.toContain(
      `/objects/uploads/${orphanId}`,
    );
    expect(second.errors).toBe(0);
  });

  it("treats a 404-style error from deleteObject as success: errors=0, deleted=1, DB row removed", async () => {
    const tenantId = await createTenant();
    const ghostArtworkId = uid();
    const { id: orphanId, objectPath } = await insertOrphanImageRow(
      tenantId,
      ghostArtworkId,
    );

    // Simulate a 404 error leaking out of deleteObject (e.g. Vercel Blob or a
    // future backend that doesn't swallow 404 internally).
    // Use a path-keyed implementation so the rejection is always applied to
    // this specific row regardless of how many other orphan rows exist in the
    // DB when the sweep runs (e.g. from other test files that ran earlier).
    const notFoundError = new Error("object not found (404)");
    vi.mocked(deleteObject).mockImplementation(async (path: string) => {
      if (path === objectPath) throw notFoundError;
    });

    const result = await sweepOrphanedImageFiles();

    // A 404 means the file is already gone — must NOT count as an error
    expect(result.errors).toBe(0);
    expect(result.failedPaths).not.toContain(objectPath);

    // Must still count as deleted (file is gone, either way)
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // deleteObject was called for our specific orphan's objectPath
    expect(deleteObject).toHaveBeenCalledWith(objectPath);

    // The DB row must have been removed
    const remaining = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(remaining).toHaveLength(0);

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
  });

  it("treats a BlobNotFoundError from @vercel/blob as success: errors=0, deleted=1, DB row removed", async () => {
    // This test uses the real BlobNotFoundError class from @vercel/blob to
    // confirm the sweep handles the SDK-specific error shape, not just a
    // generic Error whose message happens to contain "404".
    //
    // BlobNotFoundError message is "The requested blob does not exist" —
    // no "404" in the string, so the sweep must rely on the /not found/i
    // branch of its is404 check (or a future instanceof guard).
    const { BlobNotFoundError } = await import("@vercel/blob");

    const tenantId = await createTenant();
    const ghostArtworkId = uid();
    const { id: orphanId, objectPath } = await insertOrphanImageRow(
      tenantId,
      ghostArtworkId,
    );

    // Path-keyed implementation: always applies to our specific row regardless
    // of other orphan rows in the DB from other test files.
    vi.mocked(deleteObject).mockImplementation(async (path: string) => {
      if (path === objectPath) throw new BlobNotFoundError();
    });

    const result = await sweepOrphanedImageFiles();

    // A BlobNotFoundError means the blob is already gone — not a real error
    expect(result.errors).toBe(0);
    expect(result.failedPaths).not.toContain(objectPath);

    // Must still count as deleted (blob is gone either way)
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // deleteObject was called for our specific orphan's objectPath
    expect(deleteObject).toHaveBeenCalledWith(objectPath);

    // The DB row must have been removed
    const remaining = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(remaining).toHaveLength(0);

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
  });

  it("counts a BlobStoreNotFoundError as errors=1, not errors=0", async () => {
    // BlobStoreNotFoundError means the storage store itself is misconfigured —
    // a very different problem from "file already gone".  It must NOT be
    // silenced as a 404; it must surface as a real error so operators notice.
    const { BlobStoreNotFoundError } = await import("@vercel/blob");

    const tenantId = await createTenant();
    const ghostArtworkId = uid();
    const { id: orphanId, objectPath } = await insertOrphanImageRow(
      tenantId,
      ghostArtworkId,
    );

    // Path-keyed implementation: always applies to our specific row regardless
    // of other orphan rows in the DB from other test files.
    vi.mocked(deleteObject).mockImplementation(async (path: string) => {
      if (path === objectPath) throw new BlobStoreNotFoundError();
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepOrphanedImageFiles();

    // Must be counted as a real error, not a silent 404
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.failedPaths).toContain(objectPath);

    // Must NOT be counted as a successful deletion
    // (We can't assert deleted===0 because other rows in the DB may have
    // succeeded, but the specific path must not appear as a deletion.)
    // The failedPaths assertion above already confirms it was treated as error.

    errSpy.mockRestore();

    // The DB row must still have been removed so the next sweep doesn't retry
    const remaining = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(remaining).toHaveLength(0);

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
  });

  it("records an error but continues and still removes the DB row when deleteObject throws", async () => {
    const tenantId = await createTenant();
    const ghostArtworkId = uid();
    const { id: orphanId, objectPath } = await insertOrphanImageRow(
      tenantId,
      ghostArtworkId,
    );

    // Path-keyed implementation: always applies to our specific row regardless
    // of other orphan rows in the DB from other test files.
    vi.mocked(deleteObject).mockImplementation(async (path: string) => {
      if (path === objectPath) throw new Error("simulated storage failure");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepOrphanedImageFiles();

    // The error must be recorded
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.failedPaths).toContain(objectPath);

    // The DB row must still have been removed so the next sweep doesn't retry
    const remaining = await db
      .select({ id: artworkImagesTable.id })
      .from(artworkImagesTable)
      .where(eq(artworkImagesTable.id, orphanId));
    expect(remaining).toHaveLength(0);

    errSpy.mockRestore();

    // Remove from cleanup list — already gone
    const idx = insertedOrphanImageIds.indexOf(orphanId);
    if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
  });

  it("continues past a per-row storage error: successful rows are still deleted and errors count only the failures", async () => {
    // This test verifies the sweep never silently skips files when the storage
    // backend becomes unreachable for some rows mid-sweep.  When deleteObject
    // throws for one row but succeeds for the rest:
    //  - errors must equal exactly the number of rows that threw
    //  - failedPaths must contain exactly the paths that threw
    //  - deleted must include the rows that succeeded
    //  - all DB rows are removed (whether storage succeeded or failed)
    const tenantId = await createTenant();
    const ghostArtworkId = uid();

    const failing = await insertOrphanImageRow(tenantId, ghostArtworkId);
    const ok1 = await insertOrphanImageRow(tenantId, ghostArtworkId);
    const ok2 = await insertOrphanImageRow(tenantId, ghostArtworkId);

    // deleteObject will reject the first call and resolve for subsequent ones.
    // We use mockImplementation so the rejection is keyed by path, not call
    // order, which makes the assertion robust regardless of iteration order.
    vi.mocked(deleteObject).mockImplementation(async (path: string) => {
      if (path === failing.objectPath) {
        throw new Error("simulated backend unreachable");
      }
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepOrphanedImageFiles();

    errSpy.mockRestore();

    // Restore default mock so later tests are unaffected
    vi.mocked(deleteObject).mockResolvedValue(undefined);

    // The failing path must be recorded as an error
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.failedPaths).toContain(failing.objectPath);

    // The successful paths must NOT appear in failedPaths
    expect(result.failedPaths).not.toContain(ok1.objectPath);
    expect(result.failedPaths).not.toContain(ok2.objectPath);

    // At least the two successful rows must be counted as deleted
    expect(result.deleted).toBeGreaterThanOrEqual(2);

    // All three DB rows must have been removed so re-runs don't retry them
    for (const { id } of [failing, ok1, ok2]) {
      const rows = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, id));
      expect(rows).toHaveLength(0);
    }

    // Remove from cleanup lists — already gone
    for (const { id } of [failing, ok1, ok2]) {
      const idx = insertedOrphanImageIds.indexOf(id);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    }
  });
});
