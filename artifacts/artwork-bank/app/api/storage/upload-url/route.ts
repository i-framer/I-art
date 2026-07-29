import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUploadTarget, StorageNotConfiguredError } from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";

export async function POST(_request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const target = await getUploadTarget();
    return NextResponse.json(target);
  } catch (err) {
    // StorageNotConfiguredError: no storage backend env vars set at all.
    // BlobError subclasses other than BlobNotFoundError (e.g.
    // BlobStoreNotFoundError): the store itself is misconfigured.
    // Both are operator-facing config problems — log clearly and return 500.
    if (
      err instanceof StorageNotConfiguredError ||
      (err instanceof BlobError && !(err instanceof BlobNotFoundError))
    ) {
      console.error("Upload URL error (storage misconfigured):", err);
      return NextResponse.json(
        { error: "Storage misconfigured — check storage environment variables" },
        { status: 500 },
      );
    }
    console.error("Upload URL error:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 },
    );
  }
}
