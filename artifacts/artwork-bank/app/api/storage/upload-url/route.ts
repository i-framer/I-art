import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUploadTarget } from "@/lib/object-storage";

export async function POST(_request: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const target = await getUploadTarget();
    return NextResponse.json(target);
  } catch (err) {
    console.error("Upload URL error:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 },
    );
  }
}
