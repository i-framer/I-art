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
 * When no secret is configured the endpoint is open in development. In
 * production (NODE_ENV === "production") at least one of ORPHAN_SWEEP_SECRET
 * or CRON_SECRET must be set — an unconfigured production deployment returns
 * 403 to prevent strangers from triggering the sweep.
 */
import { NextResponse } from "next/server";
import { sweepOrphanedImageFiles } from "@/lib/orphan-image-sweep";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  // Accept the sweep secret or Vercel's CRON_SECRET (Vercel cron sends
  // "Authorization: Bearer $CRON_SECRET" and can only issue GET requests).
  const secrets = [
    process.env.ORPHAN_SWEEP_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);

  if (secrets.length === 0) {
    // In production, refuse to run open — the operator must configure a secret.
    if (process.env.NODE_ENV === "production") return false;
    // In development/test, allow open access for convenience.
    return true;
  }

  const auth = request.headers.get("authorization");
  return secrets.some((s) => auth === `Bearer ${s}`);
}

async function runSweep(request: Request) {
  if (!isAuthorized(request)) {
    const secrets = [
      process.env.ORPHAN_SWEEP_SECRET,
      process.env.CRON_SECRET,
    ].filter(Boolean);
    if (secrets.length === 0 && process.env.NODE_ENV === "production") {
      console.error(
        "[orphan-sweep] Endpoint blocked: no ORPHAN_SWEEP_SECRET or CRON_SECRET " +
          "is configured. Set at least one to enable this endpoint in production."
      );
      return NextResponse.json(
        {
          error:
            "Forbidden: ORPHAN_SWEEP_SECRET (or CRON_SECRET) must be set in production.",
        },
        { status: 403 }
      );
    }
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
