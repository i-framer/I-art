import { NextRequest, NextResponse } from "next/server";
import { fetchObject, StorageNotConfiguredError } from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";
import { db, artworkImagesTable, artworksTable, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

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

/**
 * Exact canonical object path: "/objects/uploads/<uuid>" — nothing else.
 * Rejects traversal-shaped or otherwise non-canonical paths outright.
 */
const CANONICAL_PATH_RE =
  /^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const objectPath = request.nextUrl.searchParams.get("path");
  if (!objectPath || !CANONICAL_PATH_RE.test(objectPath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Only serve images that belong to an artwork currently shown in the public
  // gallery.  Registration in artworkImagesTable alone is NOT sufficient —
  // hidden/draft artwork images must not be publicly readable.
  const [row] = await db
    .select({ id: artworkImagesTable.id })
    .from(artworkImagesTable)
    .innerJoin(
      artworksTable,
      eq(artworksTable.id, artworkImagesTable.artworkId),
    )
    .where(
      and(
        eq(artworkImagesTable.objectPath, objectPath),
        eq(artworksTable.showInGallery, true),
      ),
    )
    .limit(1);
  if (!row) {
    // Not an artwork image — a tenant logo is the only other public object.
    // Serve it only while the owning storefront is enabled.
    const [logoTenant] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(
        and(
          eq(tenantsTable.logoUrl, objectPath),
          eq(tenantsTable.storefrontEnabled, true),
        ),
      )
      .limit(1);
    if (!logoTenant) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
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
      // Every response is authorized against the current artwork/logo
      // visibility above. Do not let a browser or shared CDN reuse a prior
      // successful response after an owner hides or removes that content.
      "Cache-Control": "private, no-store",
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
