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
import { list as blobList } from "@vercel/blob";
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

  // For vercel-blob, do a lightweight list call to confirm the token is valid
  // and the store exists.  For replit we trust the env var check above.
  if (provider === "vercel-blob") {
    try {
      await blobList({ prefix: "_health_probe", limit: 1 });
    } catch (err) {
      if (err instanceof BlobError) {
        const msg = `Blob store unreachable: ${err.message}`;
        console.error("[storage/health]", msg);
        return NextResponse.json({ ok: false, error: msg }, { status: 503 });
      }
      // Unexpected non-Blob error — let it propagate as a 503
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[storage/health] unexpected error:", msg);
      return NextResponse.json({ ok: false, error: msg }, { status: 503 });
    }
  }

  return NextResponse.json({
    ok: true,
    provider,
    message: `Storage backend "${provider}" is reachable.`,
  });
}
