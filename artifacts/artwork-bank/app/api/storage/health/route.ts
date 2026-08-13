/**
 * GET /api/storage/health
 *
 * Lightweight storage connectivity probe for operator use.
 * Returns which backend is active and whether it can be reached.
 *
 * - 200 { ok: true,  provider: "vercel-blob" | "replit", message: string }
 * - 503 { ok: false, error: string }
 *
 * This endpoint is intentionally unauthenticated — the info it reveals
 * (provider name + reachability) is not sensitive, and it needs to be
 * curl-able without a session for uptime monitoring.
 */
import { NextResponse } from "next/server";
import {
  getStorageProvider,
  StorageNotConfiguredError,
} from "@/lib/object-storage";
import { list as blobList, put as blobPut, del as blobDel } from "@vercel/blob";
import { BlobError } from "@vercel/blob";

export const dynamic = "force-dynamic";

export async function GET() {
  let provider: string;
  try {
    provider = getStorageProvider();
  } catch (err) {
    const error =
      err instanceof StorageNotConfiguredError
        ? err.message
        : "Storage configuration error — check environment variables";
    console.error("[storage/health] Not configured:", error);
    return NextResponse.json({ ok: false, error }, { status: 503 });
  }

  // For vercel-blob, probe both read AND write to confirm full functionality.
  // The write probe catches the common case where blobList() succeeds (read is
  // allowed) but blobPut() fails (token has only list scope, or the store is
  // connected to Preview but not Production, or it is rate-limited, etc.).
  if (provider === "vercel-blob") {
    // ── read probe ──────────────────────────────────────────────────────────
    try {
      await blobList({ prefix: "_health_probe", limit: 1 });
    } catch (err) {
      if (err instanceof BlobError) {
        const msg = `Blob store unreachable (read): ${err.constructor.name}: ${err.message}`;
        console.error("[storage/health]", msg);
        return NextResponse.json({ ok: false, error: msg }, { status: 503 });
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[storage/health] unexpected read error:", msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 503 });
    }

    // ── write probe ─────────────────────────────────────────────────────────
    // Put a tiny text blob then immediately delete it so we confirm that the
    // token has write access and the store accepts PUT requests.
    const writeProbePathname = `_health_write_probe_${Date.now()}`;
    try {
      const result = await blobPut(
        writeProbePathname,
        new Blob(["health-check"], { type: "text/plain" }),
        { access: "public", contentType: "text/plain", addRandomSuffix: false },
      );
      // Best-effort delete — don't let a delete failure mask a successful write.
      blobDel(result.url).catch(() => undefined);
    } catch (err) {
      if (err instanceof BlobError) {
        const msg = `Blob store write failed: ${err.constructor.name}: ${err.message}`;
        console.error("[storage/health]", msg);
        return NextResponse.json({ ok: false, error: msg }, { status: 503 });
      }
      const msg = err instanceof Error ? err.message : "Unknown write error";
      console.error("[storage/health] unexpected write error:", msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 503 });
    }
  }

  return NextResponse.json({
    ok: true,
    provider,
    probes: provider === "vercel-blob" ? ["read", "write"] : ["config"],
    message: `Storage backend "${provider}" is reachable.`,
  });
}
