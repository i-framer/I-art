/**
 * Pure formatting utilities — no server-only imports.
 * Safe to import from both server and client components.
 */

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDimensions(
  w: number | null,
  h: number | null,
  d: number | null,
): string | null {
  if (!w && !h) return null;
  const parts = [w, h].filter(Boolean).map((v) => `${v}`);
  if (d) parts.push(`${d}`);
  return parts.join(" × ") + " mm";
}
