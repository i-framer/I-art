/**
 * POST /api/storage/upload
 *
 * Single-step server-side file upload. The browser sends the raw file body;
 * this route uploads it to the configured storage backend using a
 * server-to-server call, entirely avoiding browser CORS restrictions.
 *
 * Why server-side instead of @vercel/blob/client browser upload:
 *   The @vercel/blob/client upload() function sends PUT requests to
 *   https://vercel.com/api/blob (the Vercel management API), which does not
 *   emit CORS headers for arbitrary browser origins. The result is a 400 with
 *   "No Access-Control-Allow-Origin" in the browser console. Proxying through
 *   our own API route keeps BLOB_READ_WRITE_TOKEN server-side only and removes
 *   the CORS dependency.
 *
 * Request:
 *   POST /api/storage/upload
 *   Content-Type: image/*
 *   Body: raw file bytes
 *
 * Response 200:
 *   { objectPath: "/objects/uploads/<uuid>" }
 *
 * The caller must then call addArtworkImage(artworkId, objectPath, filename)
 * to create the DB record.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  putObject,
  StorageNotConfiguredError,
} from "@/lib/object-storage";
import { BlobError, BlobNotFoundError } from "@vercel/blob";

export const dynamic = "force-dynamic";

const ALLOWED_CONTENT_TYPE_PREFIX = "image/";
const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith(ALLOWED_CONTENT_TYPE_PREFIX)) {
    return NextResponse.json(
      { error: "Content-Type must be an image/* type" },
      { status: 400 },
    );
  }

  if (!request.body) {
    return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
  }

  // Fast-path: reject early if the client declares an oversized Content-Length.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File exceeds the maximum allowed size of ${MAX_SIZE_BYTES / (1024 * 1024)} MB` },
      { status: 413 },
    );
  }

  // Enforce the limit on the actual byte stream regardless of whether the
  // client supplied a Content-Length header (chunked / streaming uploads skip
  // it).  We buffer the whole body so we can count bytes before forwarding to
  // the storage backend.
  let bodyBuffer: ArrayBuffer;
  try {
    bodyBuffer = await request.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }

  if (bodyBuffer.byteLength > MAX_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File exceeds the maximum allowed size of ${MAX_SIZE_BYTES / (1024 * 1024)} MB` },
      { status: 413 },
    );
  }

  const uuid = crypto.randomUUID();
  const entityId = `uploads/${uuid}`;
  const objectPath = `/objects/${entityId}`;

  try {
    await putObject(entityId, new Blob([bodyBuffer], { type: contentType }), contentType);
    return NextResponse.json({ objectPath });
  } catch (err) {
    if (
      err instanceof StorageNotConfiguredError ||
      (err instanceof BlobError && !(err instanceof BlobNotFoundError))
    ) {
      console.error("[storage/upload] Storage misconfigured:", err);
      return NextResponse.json(
        { error: "Storage misconfigured — check storage environment variables" },
        { status: 500 },
      );
    }
    console.error("[storage/upload] Upload failed:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
