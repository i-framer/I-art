import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/tenant-cache";

const BASE_DOMAIN = "https://i-art.com.au";

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

  const tenantBase =
    tenant.customDomainVerified && tenant.customDomain
      ? `https://${tenant.customDomain}`
      : `${BASE_DOMAIN}/t/${slug}`;

  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /dashboard/",
    "Disallow: /settings/",
    "Disallow: /catalog/",
    "",
    `Sitemap: ${tenantBase}/sitemap.xml`,
    "",
  ].join("\n");

  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
