/**
 * One-off (but idempotent) trigger for the orphaned-image storage sweep.
 *
 * Finds every artwork_image row whose parent artwork no longer exists in the
 * database and deletes both the stored file and the stale DB row.
 *
 * This cleans up files left behind by artworks deleted before the fix that
 * made deleteArtwork also remove stored image files.
 *
 * When ORPHAN_SWEEP_SECRET is set, requests must supply it as a Bearer token:
 *   Authorization: Bearer <secret>
 * When no secret is configured the endpoint is open (development convenience).
 */
import { NextResponse } from "next/server";
import { sweepOrphanedImageFiles } from "@/lib/orphan-image-sweep";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = process.env.ORPHAN_SWEEP_SECRET;
  if (!secret) return true; // no secret configured — open (dev)
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

async function runSweep(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await sweepOrphanedImageFiles();
    console.log("[orphan-sweep] completed:", result);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Orphan image sweep failed:", msg);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return runSweep(request);
}

/** GET for convenience — easy to trigger from a browser or curl without a body. */
export async function GET(request: Request) {
  return runSweep(request);
}
