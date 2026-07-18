import { NextResponse } from "next/server";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Internal lookup: given a custom domain, return the tenant slug.
 * Called by the Edge middleware — no auth required (slug is not sensitive data).
 *
 * GET /api/tenant/by-domain?domain=www.example.com
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain")?.toLowerCase().trim();

  if (!domain) {
    return NextResponse.json({ error: "Missing domain parameter." }, { status: 400 });
  }

  const tenant = await db.query.tenantsTable.findFirst({
    where: and(
      eq(tenantsTable.customDomain, domain),
      eq(tenantsTable.customDomainVerified, true),
    ),
    columns: { slug: true },
  });

  if (!tenant) {
    return NextResponse.json({ error: "No verified tenant for this domain." }, { status: 404 });
  }

  return NextResponse.json({ slug: tenant.slug });
}
