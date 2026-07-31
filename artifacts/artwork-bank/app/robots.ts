import type { MetadataRoute } from "next";
import { getPlatformBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = getPlatformBaseUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dashboard",
          "/settings",
          "/orders",
          "/catalog",
          "/login",
          "/register",
          "/invite",
          "/platform",
        ],
      },
    ],
    ...(base ? { sitemap: `${base}/sitemap.xml` } : {}),
  };
}
