const FAVICON_SVG = `<svg width="180" height="180" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="180" height="180" rx="36" fill="#FF3C00"/></svg>`;

/**
 * Keep the legacy favicon URL available for browsers that request it
 * automatically. The SVG response uses the same Artwork Bank mark as the
 * application icon without affecting tenant storefront branding.
 */
export function GET() {
  return new Response(FAVICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}