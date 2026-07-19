import type { MetadataRoute } from "next";
import { db } from "@workspace/db";
import { artworksTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { getTenantUrl } from "@/lib/base-url";

export default async function sitemap({
  params,
}: {
  params: { slug: string };
}): Promise<MetadataRoute.Sitemap> {
  const tenant = await getTenantBySlug(params.slug);
  if (!tenant) return [];

  // Verified custom domain > platform base URL (resolved per environment)
  const tenantBase = getTenantUrl(tenant);
  if (!tenantBase) return [];

  const artworks = await db
    .select({ id: artworksTable.id, updatedAt: artworksTable.updatedAt })
    .from(artworksTable)
    .where(
      and(
        eq(artworksTable.tenantId, tenant.id),
        eq(artworksTable.showInGallery, true),
        inArray(artworksTable.status, ["AVAILABLE", "SOLD", "RESERVED"] as ("AVAILABLE" | "SOLD" | "RESERVED")[]),
      ),
    );

  const entries: MetadataRoute.Sitemap = [
    { url: tenantBase, lastModified: new Date(), changeFrequency: "daily", priority: 1 },
    ...(tenant.aboutText
      ? [{ url: `${tenantBase}/about`, lastModified: new Date(), changeFrequency: "monthly" as const, priority: 0.5 }]
      : []),
    ...artworks.map((a) => ({
      url: `${tenantBase}/${a.id}`,
      lastModified: a.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];

  return entries;
}
