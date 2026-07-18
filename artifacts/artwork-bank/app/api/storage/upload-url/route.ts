import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUploadUrl } from "@/lib/object-storage";

export async function POST(_request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { uploadURL, objectPath } = await getUploadUrl();
    return NextResponse.json({ uploadURL, objectPath });
  } catch (err) {
    console.error("Upload URL error:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 },
    );
  }
}
