import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { getTenantUrl } from "@/lib/base-url";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);

  if (!tenant || !tenant.storefrontEnabled) {
    return new NextResponse("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Verified custom domain > platform base URL (resolved per environment)
  const tenantBase = getTenantUrl(tenant);

  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /dashboard/",
    "Disallow: /settings/",
    "Disallow: /catalog/",
    "",
    ...(tenantBase ? [`Sitemap: ${tenantBase}/sitemap.xml`, ""] : []),
  ].join("\n");

  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
