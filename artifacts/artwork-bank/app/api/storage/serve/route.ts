import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { fetchObject, StorageNotConfiguredError } from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";
import { db, artworkImagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * Content types that can execute script when opened as a document in the
 * browser. These must never be served inline from the app origin.
 */
const ACTIVE_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
]);

function isActiveContentType(contentType: string): boolean {
  // Strip parameters (e.g. "image/svg+xml; charset=utf-8")
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ACTIVE_CONTENT_TYPES.has(base);
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const objectPath = request.nextUrl.searchParams.get("path");
  if (!objectPath || !objectPath.startsWith("/objects/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // ── Tenant-ownership guard ──────────────────────────────────────────────────
  // The route is only ever called from admin UI image <img> tags where src is
  // constructed from artworkImagesTable.objectPath.  All such rows are created
  // by the addArtworkImage server action which enforces tenantId at write time.
  //
  // Without this check any authenticated gallery-admin session (even from a
  // different gallery) could read another tenant's artwork images by supplying
  // a known-or-guessed object path.
  //
  // We require the path to exist in artworkImagesTable AND belong to the
  // session's own tenant.  A mismatch (wrong tenant) and a missing row (path
  // not yet associated with an image row) both return 403 so callers cannot
  // distinguish "wrong tenant" from "path does not exist."
  if (!session.tenantId) {
    // Logged-in users without a tenant context (e.g. super-admins with no
    // gallery affiliation) cannot use this endpoint.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const imageRow = await db.query.artworkImagesTable.findFirst({
    where: and(
      eq(artworkImagesTable.objectPath, objectPath),
      eq(artworkImagesTable.tenantId, session.tenantId),
    ),
    columns: { id: true },
  });

  if (!imageRow) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const upstream = await fetchObject(objectPath);
    const contentType =
      upstream.headers.get("Content-Type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("Content-Length");

    const headers = new Headers({
      "Content-Type": contentType,
      // Prevent browsers from MIME-sniffing away from the declared type.
      "X-Content-Type-Options": "nosniff",
      // Active content types (SVG, HTML, …) must never open as a document at
      // the app origin — force a download so scripts cannot run in our context.
      "Content-Disposition": isActiveContentType(contentType)
        ? "attachment"
        : "inline",
      // Tell browsers not to cache this authenticated endpoint aggressively.
      "Cache-Control": "private, max-age=3600",
    });
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    // StorageNotConfiguredError: no storage backend env vars set at all.
    // BlobError subclasses other than BlobNotFoundError (e.g.
    // BlobStoreNotFoundError): the store itself is misconfigured.
    // Both are operator-facing config problems — log clearly and return 500.
    if (
      err instanceof StorageNotConfiguredError ||
      (err instanceof BlobError && !(err instanceof BlobNotFoundError))
    ) {
      console.error("Serve error (storage misconfigured):", err);
      return NextResponse.json(
        { error: "Storage misconfigured — check storage environment variables" },
        { status: 500 },
      );
    }
    // BlobNotFoundError or any other error means the specific object is absent or unreachable.
    console.error("Serve error for path", objectPath, ":", err);
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }
}
