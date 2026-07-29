import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getServeUrl, StorageNotConfiguredError } from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const objectPath = request.nextUrl.searchParams.get("path");
  if (!objectPath || !objectPath.startsWith("/objects/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  try {
    const signedUrl = await getServeUrl(objectPath, 3600);
    return NextResponse.redirect(signedUrl);
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
    // BlobNotFoundError or any other error means the specific object is absent.
    console.error("Serve error:", err);
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }
}
