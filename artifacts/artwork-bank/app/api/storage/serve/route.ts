import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getServeUrl } from "@/lib/object-storage";

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
    console.error("Serve error:", err);
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }
}
