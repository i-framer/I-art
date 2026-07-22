/**
 * Client-upload token exchange for the Vercel Blob storage backend.
 *
 * The browser calls `upload()` from @vercel/blob/client pointing at this
 * route; we authenticate the session, then hand back a scoped client token
 * so the file goes straight from the browser to the Blob store (bypassing
 * the serverless request-body size limit). Only used when the storage
 * provider is "vercel-blob".
 */
import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;
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
      onUploadCompleted: async () => {
        // The DB record is created by the client via addArtworkImage after
        // the upload succeeds — nothing to do here.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    console.error("Blob upload token error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 400 });
  }
}
