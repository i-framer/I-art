import type { FreightMethod, FreightSettings } from "@workspace/db";

export type FreightClass = "SMALL" | "MEDIUM" | "LARGE" | "TUBE";
export type ArtworkShippingFormat = "STANDARD" | "TUBE";

export const DEFAULT_FREIGHT_THRESHOLDS = {
  smallMaxMm: 800,
  mediumMaxMm: 1500,
} as const;

export function getFreightClass(
  artwork: {
    dimensionsW: number | null;
    dimensionsH: number | null;
    dimensionsD: number | null;
    shippingFormat: ArtworkShippingFormat;
  },
  settings?: Pick<FreightSettings, "smallMaxMm" | "mediumMaxMm"> | null,
): FreightClass | null {
  if (artwork.shippingFormat === "TUBE") return "TUBE";
  if (!artwork.dimensionsW || !artwork.dimensionsH) return null;

  const thresholds = settings ?? DEFAULT_FREIGHT_THRESHOLDS;
  const longestDimension = Math.max(
    artwork.dimensionsW,
    artwork.dimensionsH,
    artwork.dimensionsD ?? 0,
  );
  if (longestDimension <= thresholds.smallMaxMm) return "SMALL";
  if (longestDimension <= thresholds.mediumMaxMm) return "MEDIUM";
  return "LARGE";
}

export function getFreightCents(
  method: Pick<
    FreightMethod,
    "smallCents" | "mediumCents" | "largeCents" | "tubeCents"
  >,
  freightClass: FreightClass,
): number {
  switch (freightClass) {
    case "SMALL":
      return method.smallCents;
    case "MEDIUM":
      return method.mediumCents;
    case "LARGE":
      return method.largeCents;
    case "TUBE":
      return method.tubeCents;
  }
}

export function formatFreightClass(freightClass: FreightClass): string {
  return freightClass === "TUBE"
    ? "Rolled / tube"
    : `${freightClass[0]}${freightClass.slice(1).toLowerCase()} parcel`;
}