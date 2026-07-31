import type { MetadataRoute } from "next";
import { getPlatformBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";

/**
 * Platform-level sitemap: landing page and public artwork discovery.
 * Tenant storefronts have their own per-tenant sitemaps at /t/[slug]/sitemap.xml.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = getPlatformBaseUrl();
  if (!base) return [];

  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/browse`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
  ];
}
