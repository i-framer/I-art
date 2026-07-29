/**
 * One-off (but idempotent) sweep that removes stored image files whose parent
 * artwork has already been deleted from the database.
 *
 * Background: the `deleteArtwork` action was fixed to also delete stored image
 * files, but artworks deleted *before* that fix left orphaned files in storage.
 * This sweep finds every `artworkImagesTable` row whose `artworkId` no longer
 * exists in `artworksTable`, deletes the stored file from storage, and removes
 * the stale DB row.
 *
 * It is safe to run multiple times — if a file has already been removed from
 * storage the storage backend returns 404 which is treated as success, and the
 * DB row is removed regardless of the storage outcome.
 */

import { db } from "@workspace/db";
import { artworkImagesTable, artworksTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { BlobNotFoundError } from "@vercel/blob";
import { deleteObject } from "@/lib/object-storage";

export interface OrphanSweepResult {
  /** Total artwork_image rows examined */
  checked: number;
  /** Rows whose artworkId no longer exists (orphans found) */
  orphaned: number;
  /** Storage files successfully deleted (or already gone) */
  deleted: number;
  /** Storage deletions that failed with an unexpected error */
  errors: number;
  /** objectPath values that failed to delete */
  failedPaths: string[];
}

export async function sweepOrphanedImageFiles(): Promise<OrphanSweepResult> {
  // 1. Fetch all image rows (objectPath + artworkId).
  //    We need the full list first so we can cross-reference.
  const allImageRows = await db
    .select({ id: artworkImagesTable.id, artworkId: artworkImagesTable.artworkId, objectPath: artworkImagesTable.objectPath })
    .from(artworkImagesTable);

  const result: OrphanSweepResult = {
    checked: allImageRows.length,
    orphaned: 0,
    deleted: 0,
    errors: 0,
    failedPaths: [],
  };

  if (allImageRows.length === 0) {
    return result;
  }

  // 2. Find which artworkIds still exist.
  const uniqueArtworkIds = [...new Set(allImageRows.map((r) => r.artworkId))];

  const existingArtworkRows = await db
    .select({ id: artworksTable.id })
    .from(artworksTable)
    .where(inArray(artworksTable.id, uniqueArtworkIds));

  const existingIds = new Set(existingArtworkRows.map((r) => r.id));

  // 3. Filter to orphaned image rows.
  const orphanedRows = allImageRows.filter((r) => !existingIds.has(r.artworkId));
  result.orphaned = orphanedRows.length;

  if (orphanedRows.length === 0) {
    return result;
  }

  // 4. For each orphan: delete from storage (best-effort), then remove DB row.
  for (const row of orphanedRows) {
    let storageOk = false;
    try {
      await deleteObject(row.objectPath);
      storageOk = true;
      result.deleted++;
      console.log(`[orphan-sweep] deleted storage object: ${row.objectPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404-style responses are swallowed inside deleteObject for the Replit
      // backend, but other backends (e.g. Vercel Blob) or future changes may
      // surface a 404 as a thrown error.  The file is already gone — treat
      // this as a successful deletion so the DB row is cleaned up and the
      // error count stays accurate.
      //
      // @vercel/blob throws BlobNotFoundError whose message is
      // "Vercel Blob: The requested blob does not exist" — no "404" substring
      // and no "not found" substring — so we check instanceof explicitly.
      const is404 =
        err instanceof BlobNotFoundError ||
        (err instanceof Error && "status" in err && (err as { status: unknown }).status === 404) ||
        /\b404\b/.test(msg) ||
        /not found/i.test(msg) ||
        /does not exist/i.test(msg);
      if (is404) {
        storageOk = true;
        result.deleted++;
        console.log(`[orphan-sweep] object already gone (404): ${row.objectPath}`);
      } else {
        console.error(`[orphan-sweep] failed to delete ${row.objectPath}: ${msg}`);
        result.errors++;
        result.failedPaths.push(row.objectPath);
      }
    }

    // Remove the stale DB row regardless of storage outcome so a re-run
    // doesn't keep attempting the same deletion.
    try {
      await db
        .delete(artworkImagesTable)
        .where(inArray(artworkImagesTable.id, [row.id]));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orphan-sweep] failed to remove DB row ${row.id}: ${msg}`);
      // Don't increment errors again — this is the DB row, not the storage file.
      // Leave it; the next run will retry the storage deletion, which will 404
      // and be treated as success, then remove the row.
      if (storageOk) {
        // We already counted this as deleted from storage, that's still true.
      }
    }
  }

  return result;
}
