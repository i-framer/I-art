import { NextRequest, NextResponse } from "next/server";
import { fetchObject, StorageNotConfiguredError } from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";
import { db, artworkImagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Public artwork-image serving route.
 *
 * The production blob store is PRIVATE — raw blob URLs return 403 to
 * browsers.  Public storefront pages therefore reference this route, which
 * streams the object through the app using the server-side storage
 * credentials.
 *
 * Only object paths registered in artworkImagesTable are served.  Those rows
 * are created exclusively by the authenticated addArtworkImage action, and
 * every artwork image is public-facing storefront content, so no session is
 * required here.  Anything else (unregistered uploads, arbitrary paths) is a
 * 404.
 */

/** Content types that can execute script when opened as a document. */
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
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ACTIVE_CONTENT_TYPES.has(base);
}

export async function GET(request: NextRequest) {
  const objectPath = request.nextUrl.searchParams.get("path");
  if (!objectPath || !objectPath.startsWith("/objects/uploads/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Only serve objects that are registered artwork images.
  const imageRow = await db.query.artworkImagesTable.findFirst({
    where: eq(artworkImagesTable.objectPath, objectPath),
    columns: { id: true },
  });
  if (!imageRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const upstream = await fetchObject(objectPath);
    const contentType =
      upstream.headers.get("Content-Type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("Content-Length");

    const headers = new Headers({
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      // Active content types (SVG, HTML, …) must never render as a document
      // at the app origin — force a download so scripts cannot run here.
      "Content-Disposition": isActiveContentType(contentType)
        ? "attachment"
        : "inline",
      // Artwork images are immutable (a new upload gets a new UUID), so allow
      // long shared caching to keep storefront pages fast.
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
    });
    if (contentLength) headers.set("Content-Length", contentLength);

    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    if (
      err instanceof StorageNotConfiguredError ||
      (err instanceof BlobError && !(err instanceof BlobNotFoundError))
    ) {
      console.error("Public serve error (storage misconfigured):", err);
      return NextResponse.json(
        { error: "Storage misconfigured" },
        { status: 500 },
      );
    }
    console.error("Public serve error for path", objectPath, ":", err);
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }
}
