/**
 * Client-upload token exchange for the Vercel Blob storage backend.
 *
 * Handles two request types from @vercel/blob:
 *
 *   blob.generate-client-token — browser request to get a scoped upload token.
 *     Requires a valid user session; the token lets the browser PUT the file
 *     directly to Vercel Blob (bypassing the 4.5 MB serverless body limit).
 *
 *   blob.upload-completed — server-to-server callback Vercel sends after a
 *     successful upload (only present when onUploadCompleted is configured).
 *     Must NOT require a user session — Vercel's servers have no cookie.
 *     Authentication is handled by handleUpload via x-vercel-signature HMAC.
 *
 * We parse the request type before the session guard so both cases are routed
 * correctly. Only blob.generate-client-token is gated on session auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { BlobError, BlobNotFoundError } from "@vercel/blob";
import { getSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  // Clone the request so handleUpload can re-read the body after we peek at it.
  const cloned = request.clone();
  let body: HandleUploadBody;
  try {
    body = (await cloned.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // blob.generate-client-token comes from the browser — enforce session auth.
  // blob.upload-completed comes from Vercel's servers — handled by x-vercel-signature
  // inside handleUpload; enforcing session here would always 401 that callback.
  if (body.type === "blob.generate-client-token") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("uploads/")) {
          throw new Error("Invalid upload pathname");
        }
        return {
          allowedContentTypes: ["image/*"],
          addRandomSuffix: false,
          maximumSizeInBytes: 25 * 1024 * 1024, // 25 MB
        };
      },
      // onUploadCompleted is intentionally omitted. The DB record is created
      // by the client via addArtworkImage after the upload resolves. Providing
      // an empty callback causes handleUpload to embed a callbackUrl in the
      // client token, which can trigger Vercel's CORS-less 400 path; omitting
      // it keeps the token minimal.
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    // BlobStoreNotFoundError and other BlobError subclasses (except
    // BlobNotFoundError, which means a specific file is absent) indicate a
    // storage misconfiguration.  Return 500 so operators see a hard failure
    // rather than a client-looking 400 that is easy to ignore.
    if (err instanceof BlobError && !(err instanceof BlobNotFoundError)) {
      console.error("Blob upload token error (store misconfigured):", err);
      return NextResponse.json(
        { error: "Storage misconfigured — check BLOB_READ_WRITE_TOKEN" },
        { status: 500 },
      );
    }
    console.error("Blob upload token error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 400 });
  }
}
