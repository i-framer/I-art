/**
 * Pure certificate helpers — kept out of actions.ts because "use server"
 * files may only export async functions.
 */

/**
 * Format a tenant-scoped sequential number into a human-readable certificate
 * number, e.g. seq=3, year=2026 → "CERT-2026-0003".
 */
export function formatCertificateNumber(seq: number, year: number): string {
  return `CERT-${year}-${String(seq).padStart(4, "0")}`;
}
