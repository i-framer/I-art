/**
 * Pure consignment helpers — kept out of actions.ts because "use server"
 * files may only export async functions.
 */

/**
 * Calculate artist and gallery amounts from a sale price and artist percentage.
 * Artist amount = floor(salePriceCents * artistPct / 100).
 * Gallery amount = salePriceCents - artistAmount.
 */
export function calculateSplit(
  salePriceCents: number,
  artistPct: number,
): { artistAmountCents: number; galleryAmountCents: number } {
  const artistAmountCents = Math.floor((salePriceCents * artistPct) / 100);
  return {
    artistAmountCents,
    galleryAmountCents: salePriceCents - artistAmountCents,
  };
}
